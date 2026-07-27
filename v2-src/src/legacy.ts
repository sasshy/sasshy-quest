import { db } from './db';
import { createMemo, createTask } from './store';

interface LegacyTask {
  id?: string;
  title?: string;
  nextAction?: string;
  done?: boolean;
  scheduledDate?: string;
  startTime?: string;
  planMin?: number;
  rank?: string;
  created?: number;
  completedAt?: number | string;
  doneAt?: number | string;
}

interface LegacyMemo {
  id?: string;
  title?: string;
  body?: string;
  category?: string;
  pinned?: boolean;
  taskedAt?: number;
  reminderAt?: string;
  created?: number;
}

interface LegacyState {
  tasks?: LegacyTask[];
  memos?: LegacyMemo[];
}

export interface LegacySummary {
  available: boolean;
  tasks: number;
  memos: number;
  alreadyImportedTasks: number;
  alreadyImportedMemos: number;
}

function readLegacy(): LegacyState | null {
  try {
    const raw = localStorage.getItem('sasshy_quest_v5');
    return raw ? JSON.parse(raw) as LegacyState : null;
  } catch {
    return null;
  }
}

function startMinute(value?: string): number | null {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function toIso(value?: number | string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function legacySummary(): Promise<LegacySummary> {
  const legacy = readLegacy();
  const [tasks, memos] = await Promise.all([db.tasks.toArray(), db.memos.toArray()]);
  const taskIds = new Set(tasks.map((item) => item.legacyId).filter(Boolean));
  const memoIds = new Set(memos.map((item) => item.legacyId).filter(Boolean));
  return {
    available: Boolean(legacy),
    tasks: legacy?.tasks?.length || 0,
    memos: legacy?.memos?.length || 0,
    alreadyImportedTasks: legacy?.tasks?.filter((item) => item.id && taskIds.has(item.id)).length || 0,
    alreadyImportedMemos: legacy?.memos?.filter((item) => item.id && memoIds.has(item.id)).length || 0,
  };
}

export async function importLegacy(): Promise<{ tasks: number; memos: number }> {
  const legacy = readLegacy();
  if (!legacy) throw new Error('この端末には旧版データが見つかりません');
  const [currentTasks, currentMemos] = await Promise.all([db.tasks.toArray(), db.memos.toArray()]);
  const taskIds = new Set(currentTasks.map((item) => item.legacyId).filter(Boolean));
  const memoIds = new Set(currentMemos.map((item) => item.legacyId).filter(Boolean));
  let taskCount = 0;
  let memoCount = 0;

  for (const old of legacy.tasks || []) {
    const legacyId = old.id || `legacy-task-${old.created || taskCount}`;
    if (taskIds.has(legacyId) || !old.title?.trim()) continue;
    const task = await createTask({
      title: old.title,
      notes: old.nextAction || '',
      scheduledDate: old.scheduledDate || null,
      startMinute: startMinute(old.startTime),
      durationMin: Math.max(5, Number(old.planMin) || 25),
      estimateMin: Math.max(5, Number(old.planMin) || 25),
      importance: old.rank === 'boss' ? 2 : old.rank === 'mid' ? 1 : 0,
      urgency: old.rank === 'boss' ? 2 : 0,
      source: 'legacy',
      legacyId,
    }, 'import');
    if (old.done) {
      const completedAt = toIso(old.completedAt || old.doneAt) || new Date().toISOString();
      await db.tasks.update(task.id, { status: 'done', completedAt });
    }
    taskIds.add(legacyId);
    taskCount += 1;
  }

  for (const old of legacy.memos || []) {
    const legacyId = old.id || `legacy-memo-${old.created || memoCount}`;
    if (memoIds.has(legacyId) || (!old.title?.trim() && !old.body?.trim())) continue;
    await createMemo({
      title: old.title || '',
      body: old.body || '',
      category: old.category || '未整理',
      pinned: Boolean(old.pinned),
      reminderAt: old.reminderAt || null,
      source: 'legacy',
      legacyId,
    }, 'import');
    memoIds.add(legacyId);
    memoCount += 1;
  }

  return { tasks: taskCount, memos: memoCount };
}
