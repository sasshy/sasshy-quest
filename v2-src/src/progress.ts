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

/**
 * 今週のビン: one marble per finished task, a fresh jar every Monday. Small
 * numbers you can count, compared only with your own past weeks.
 */
export const weekStart = (d: Date): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
export interface WeekJar { start: string; marbles: number; minutes: number }

/** Jars for the last `weeks` weeks, oldest first; the last one is this week. */
export function weeklyJars(tasks: Task[], sessions: FocusSession[], now = new Date(), weeks = 8): WeekJar[] {
  const first = weekStart(now);
  first.setDate(first.getDate() - 7 * (weeks - 1));
  const jars: WeekJar[] = Array.from({ length: weeks }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + 7 * i);
    return { start: localDateKey(d), marbles: 0, minutes: 0 };
  });
  const index = (iso: string) => Math.round((weekStart(new Date(iso)).getTime() - first.getTime()) / (7 * 86_400_000));
  for (const t of tasks) {
    if (t.deletedAt || t.log || t.status !== 'done' || !t.completedAt) continue;
    const i = index(t.completedAt);
    if (i >= 0 && i < weeks) jars[i].marbles += 1;
  }
  for (const s of sessions) {
    const sec = sessionActiveSeconds(s);
    if (!sec || !s.endedAt) continue;
    const i = index(s.endedAt);
    if (i >= 0 && i < weeks) jars[i].minutes += sec / 60;
  }
  return jars.map((j) => ({ ...j, minutes: Math.round(j.minutes) }));
}

/** Best week before this one (over every recorded week). */
export function bestPastWeek(tasks: Task[], now = new Date()): number {
  const thisWeek = weekStart(now).getTime();
  const counts = new Map<number, number>();
  for (const t of tasks) {
    if (t.deletedAt || t.log || t.status !== 'done' || !t.completedAt) continue;
    const w = weekStart(new Date(t.completedAt)).getTime();
    if (w < thisWeek) counts.set(w, (counts.get(w) || 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export interface Celebration { marbles: number; record: boolean; doneToday: number; workTodayMin: number; workMonthMin: number }

/** Called after a task is completed: a marble drops into this week's jar (bigger burst on a new best week). */
export async function announceCompletion(): Promise<Celebration> {
  const tasks = await db.tasks.toArray();
  const sessions = await db.sessions.toArray();
  const p = computeProgress(tasks, sessions);
  const jars = weeklyJars(tasks, sessions, new Date(), 2);
  const marbles = jars[1].marbles;
  const best = bestPastWeek(tasks);
  const celebration: Celebration = {
    marbles, record: best > 0 && marbles === best + 1,
    doneToday: p.doneToday, workTodayMin: p.workTodayMin, workMonthMin: p.workMonthMin,
  };
  window.dispatchEvent(new CustomEvent('sasshy-celebrate', { detail: celebration }));
  window.dispatchEvent(new CustomEvent('sasshy-toast', {
    detail: `✓ 今週${marbles}個目のビー玉　今日の作業 ${minutesText(p.workTodayMin)}`,
  }));
  return celebration;
}
