import { db } from './db';
import { sessionActiveSeconds } from './insights';
import type { FocusSession, Task } from './types';
import { localDateKey } from './work-start';

/** Numbers that only go up: what has been done, never a streak to lose. */
export interface Progress { doneToday: number; workTodayMin: number; workMonthMin: number; workTotalMin: number; doneTotal: number }

export function computeProgress(tasks: Task[], sessions: FocusSession[], now = new Date()): Progress {
  const today = localDateKey(now);
  const month = today.slice(0, 7);
  let workTodayMin = 0;
  let workMonthMin = 0;
  let workTotalMin = 0;
  for (const s of sessions) {
    const sec = sessionActiveSeconds(s);
    if (!sec || !s.endedAt) continue;
    const key = localDateKey(new Date(s.endedAt));
    const min = sec / 60;
    workTotalMin += min;
    if (key.startsWith(month)) workMonthMin += min;
    if (key === today) workTodayMin += min;
  }
  const done = tasks.filter((t) => !t.deletedAt && t.status === 'done' && t.completedAt);
  return {
    doneToday: done.filter((t) => localDateKey(new Date(t.completedAt!)) === today).length,
    doneTotal: done.length,
    workTodayMin: Math.round(workTodayMin),
    workMonthMin: Math.round(workMonthMin),
    workTotalMin: Math.round(workTotalMin),
  };
}

export const minutesText = (min: number) =>
  min >= 60 ? `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}` : `${min}分`;

export interface Celebration { gainedXp: number; level: number; levelUp: boolean; doneToday: number; workTodayMin: number; workMonthMin: number }

const LEVEL_KEY = 'sasshy-last-level';
const XP_KEY = 'sasshy-last-xp';
const readNumber = (key: string): number | null => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
};
const writeNumber = (key: string, value: number) => {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode */ }
};

/** Called after a task is completed: celebration (check, XP, maybe level up) and a short summary. */
export async function announceCompletion(): Promise<Celebration> {
  const p = computeProgress(await db.tasks.toArray(), await db.sessions.toArray());
  const xp = xpFrom(p);
  const { level } = levelFrom(xp);
  const lastXp = readNumber(XP_KEY);
  const lastLevel = readNumber(LEVEL_KEY) ?? level;
  const gainedXp = lastXp === null ? 10 : Math.max(10, xp - lastXp);
  writeNumber(XP_KEY, xp);
  writeNumber(LEVEL_KEY, level);
  const celebration: Celebration = {
    gainedXp, level, levelUp: level > lastLevel,
    doneToday: p.doneToday, workTodayMin: p.workTodayMin, workMonthMin: p.workMonthMin,
  };
  window.dispatchEvent(new CustomEvent('sasshy-celebrate', { detail: celebration }));
  window.dispatchEvent(new CustomEvent('sasshy-toast', {
    detail: `✓ 今日${p.doneToday}件目　今日の作業 ${minutesText(p.workTodayMin)}・今月 ${minutesText(p.workMonthMin)}`,
  }));
  return celebration;
}

/** XP = 10 per completed task + 1 per minute worked. Derived from records, so it only grows. */
export const XP_PER_LEVEL = 100;
export function xpFrom(p: Pick<Progress, 'doneTotal' | 'workTotalMin'>): number {
  return p.doneTotal * 10 + p.workTotalMin;
}
export function levelFrom(xp: number): { level: number; into: number; need: number } {
  return { level: Math.floor(xp / XP_PER_LEVEL) + 1, into: xp % XP_PER_LEVEL, need: XP_PER_LEVEL };
}
