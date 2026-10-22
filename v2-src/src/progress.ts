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

/** Called after a task is completed: a short "it adds up" message. */
export async function announceCompletion(): Promise<void> {
  const p = computeProgress(await db.tasks.toArray(), await db.sessions.toArray());
  window.dispatchEvent(new CustomEvent('sasshy-toast', {
    detail: `✓ 今日${p.doneToday}件目　今日の作業 ${minutesText(p.workTodayMin)}・今月 ${minutesText(p.workMonthMin)}`,
  }));
}
