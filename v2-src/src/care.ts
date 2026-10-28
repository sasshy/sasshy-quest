import { db } from './db';
import { updateTask } from './store';
import { workDayKey } from './dayline';
import type { Task } from './types';

/**
 * 整備ストック：期限のない片付け・整理・発注・マニュアル作りなど。
 * 放っておくと永遠に後回しになるので、毎日1つだけ「今日」に出す。
 * 昨日の分が終わっていなければ、それを今日にもう一度出す（増やさない）。
 */
export const isCareTask = (t: Task) => t.horizon === 'care' && !t.deletedAt && !t.log && t.status !== 'done';

export function pickCare(tasks: Task[], today: string): { task: Task; carried: boolean } | null {
  const care = tasks.filter(isCareTask);
  if (care.some((t) => t.scheduledDate === today)) return null;
  // 今日もう1つ終えていたら出さない。
  if (tasks.some((t) => t.horizon === 'care' && t.status === 'done' && t.completedAt && workDayKey(t.completedAt) === today)) return null;
  const carried = care.filter((t) => t.scheduledDate && t.scheduledDate < today).sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''))[0];
  if (carried) return { task: carried, carried: true };
  const next = care.filter((t) => !t.scheduledDate).sort((a, b) => b.importance - a.importance || a.createdAt.localeCompare(b.createdAt))[0];
  return next ? { task: next, carried: false } : null;
}

export async function dailyCarePick(now = Date.now()): Promise<Task | null> {
  const KEY = 'sasshy-care-day';
  const today = workDayKey(new Date(now).toISOString());
  try {
    if (localStorage.getItem(KEY) === today) return null;
    localStorage.setItem(KEY, today);
  } catch {
    return null;
  }
  const picked = pickCare(await db.tasks.toArray(), today);
  if (!picked) return null;
  return updateTask(picked.task.id, { scheduledDate: today, startMinute: null, isFixed: false }, '今日の整備');
}
