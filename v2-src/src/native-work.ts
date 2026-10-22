import { liveQuery } from 'dexie';
import { db } from './db';
import { workReminderSlot } from '../supabase/functions/_shared/work-reminder';
import { syncNow } from './sync';
import { announceChange, applyRemoteRecord } from './store';
import type { Memo, Task } from './types';
import { buildStandardPrompts, mergePrompts } from './native-standard';
import { DEFAULT_MEAL_REMINDER, getMealReminder, lunchPrompts, type MealReminderSetting } from './meals';

export function buildWorkPrompts(tasks: Task[], now = Date.now()) {
  const prompts: { id: string; fireAt: string; title: string; body: string }[] = [];
  const seen = new Set<string>();
  // Finite reservations: refreshing in the app extends the horizon, never creates an endless stale reminder.
  for (let at = Math.ceil((now + 2000) / 60000) * 60000; at < now + 7 * 86400000 && prompts.length < 48; at += 60000) {
    for (const task of tasks) {
      const slot = workReminderSlot(task, at);
      if (slot === null || slot < now || slot > at) continue;
      const id = `${task.id}-${slot}`;
      if (seen.has(id)) continue;
      seen.add(id);
      prompts.push({ id, fireAt: new Date(Math.max(slot, at)).toISOString(), title: '未対応の仕事', body: `${task.title}${task.counterparty ? '／' + task.counterparty : ''}` });
      if (prompts.length === 48) break;
    }
  }
  return prompts;
}

export function startNativeWork() {
  const bridge = (window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: { postMessage: (value: unknown) => void } } } }).webkit?.messageHandlers?.sasshyAlarm;
  if (!bridge) return;
  let revision = 0;
  let currentTasks: Task[] | undefined;
  let currentMemos: Memo[] = [];
  let currentMealReminder: MealReminderSetting = DEFAULT_MEAL_REMINDER;
  // Task-start and memo reminders share the work-reminder bridge (soonest first, max 48).
  const refresh = () => { if (currentTasks) bridge.postMessage({ action: 'syncWork', prompts: mergePrompts([buildStandardPrompts(currentTasks, currentMemos), lunchPrompts(currentMemos, currentMealReminder), buildWorkPrompts(currentTasks)]) }); };
  liveQuery(async () => ({ tasks: await db.tasks.toArray(), sessions: await db.sessions.toArray(), memos: await db.memos.toArray(), mealReminder: await getMealReminder(), sync: await db.settings.get('sync') })).subscribe(async ({ tasks, sessions, memos, mealReminder, sync }) => {
    const currentRevision = ++revision;
    const active = new Set(sessions.filter(s => !s.deletedAt && ['running', 'paused'].includes(s.status)).map(s => s.taskId));
    currentTasks = tasks.map(t => active.has(t.id) ? { ...t, status: 'active' as const } : t);
    currentMemos = memos;
    currentMealReminder = mealReminder;
    refresh();
    const key = typeof sync?.syncKey === 'string' ? sync.syncKey : '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    if (currentRevision !== revision) return;
    bridge.postMessage({ action: 'voiceReady', workspace: key ? Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('') : '', enabled: Boolean(sync?.enabled) });
  });
  window.addEventListener('sasshy-voice-saved', (event) => {
    void (async () => {
      const task = (event as CustomEvent<{ task?: Task }>).detail?.task;
      if (task?.id) {
        const normalized = { ...task, sync: task.sync || { deviceId: 'voice' } };
        await applyRemoteRecord('task', normalized, Boolean(normalized.deletedAt), normalized.updatedAt || new Date().toISOString());
        announceChange();
      }
      await syncNow(true).catch(() => undefined);
    })();
  });
  document.addEventListener('visibilitychange', refresh);
  window.setInterval(refresh, 60000);
}
