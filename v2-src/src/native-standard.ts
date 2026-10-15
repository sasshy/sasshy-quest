import type { Memo, Task } from './types';

/**
 * Local (on-device) equivalents of the Web Push "standard" notifications:
 * task start time and memo reminder time. They are scheduled through the same
 * native bridge as the work reminders, so no Swift change is needed.
 */
export interface NativePrompt { id: string; fireAt: string; title: string; body: string }

const HORIZON_MS = 7 * 86_400_000;

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Same rule as Web: records without an explicit choice stay on; only `false` turns it off. */
export function taskStartEnabled(task: Task): boolean {
  return (task as unknown as { scheduledStartNotification?: unknown }).scheduledStartNotification !== false;
}

export function taskStartAt(task: Task): number | null {
  if (task.deletedAt || ['done', 'archived', 'active'].includes(task.status)) return null;
  if (!taskStartEnabled(task)) return null;
  const date = task.scheduledDate;
  const minute = task.startMinute;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60, 0, 0).getTime();
  return Number.isFinite(at) ? at : null;
}

export function memoReminderAt(memo: Memo): number | null {
  if (memo.archived || memo.deletedAt || !memo.reminderAt) return null;
  const at = Date.parse(memo.reminderAt);
  return Number.isFinite(at) ? at : null;
}

export function buildStandardPrompts(tasks: Task[], memos: Memo[], now = Date.now()): NativePrompt[] {
  const inWindow = (at: number) => at > now + 2000 && at <= now + HORIZON_MS;
  const prompts: NativePrompt[] = [];
  for (const task of tasks) {
    const at = taskStartAt(task);
    if (at === null || !inWindow(at)) continue;
    prompts.push({
      id: `start-${task.id}-${at}`,
      fireAt: new Date(at).toISOString(),
      title: '予定の時間です',
      body: clip(task.title, 180) || 'SASSHYのタスクを確認してください',
    });
  }
  for (const memo of memos) {
    const at = memoReminderAt(memo);
    if (at === null || !inWindow(at)) continue;
    prompts.push({
      id: `memo-${memo.id}-${at}`,
      fireAt: new Date(at).toISOString(),
      title: clip(memo.title, 120) || 'SASSHYメモ',
      body: clip(memo.body, 180) || '設定した時刻になりました',
    });
  }
  return prompts;
}

/**
 * The native side reserves at most 48 requests for this bridge. Keep the
 * soonest ones; the app refreshes every minute and on return to foreground,
 * so later items are added as earlier ones fire.
 */
export function mergePrompts(groups: NativePrompt[][], limit = 48): NativePrompt[] {
  const seen = new Set<string>();
  return groups.flat()
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
    .slice(0, limit);
}
