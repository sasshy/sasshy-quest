import { db } from './db';
import { createMemo, updateMemo } from './store';
import type { HabitInfo, Memo } from './types';
import { companionMoment } from './companion-events';

/**
 * 習慣: check the days you did it, see them on a calendar. Deliberately no
 * streaks — a missed day never resets anything; only "今月◯回" goes up.
 */
export const HABIT_CATEGORY = '習慣';

export function isHabitMemo(memo: Memo): boolean {
  return memo.category === HABIT_CATEGORY && Boolean(memo.habit);
}

export function habits(memos: Memo[]): Memo[] {
  return memos
    .filter((m) => !m.deletedAt && !m.archived && isHabitMemo(m))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createHabit(name: string, routineName: string | null = null, stepOf: string | null = null): Promise<Memo> {
  const text = name.trim().slice(0, 40);
  if (!text) throw new Error('習慣の名前を書いてください');
  const habit: HabitInfo = { name: text, days: [], routineName, ...(stepOf ? { stepOf } : {}) };
  return createMemo({ title: `習慣：${text}`, body: '', category: HABIT_CATEGORY, habit });
}

export async function setHabitDay(memo: Memo, date: string, done: boolean): Promise<Memo | null> {
  if (memo.habit!.days.includes(date) === done) return memo;
  const days = new Set(memo.habit!.days);
  if (done) days.add(date); else days.delete(date);
  if (done) companionMoment('habit');
  return updateMemo(memo.id, { habit: { ...memo.habit!, days: [...days].sort() } }, done ? `${memo.habit!.name}をやった` : `${memo.habit!.name}のチェックを外す`);
}

export async function renameHabit(memo: Memo, name: string): Promise<Memo | null> {
  const text = name.trim().slice(0, 40);
  if (!text) return memo;
  return updateMemo(memo.id, { habit: { ...memo.habit!, name: text }, title: `習慣：${text}` }, '習慣の名前を変更');
}

export async function archiveHabit(memo: Memo): Promise<Memo | null> {
  return updateMemo(memo.id, { archived: true }, `習慣「${memo.habit!.name}」をしまう`);
}

export const countIn = (memo: Memo, prefix: string) => memo.habit!.days.filter((d) => d.startsWith(prefix)).length;

/** A routine was finished: check its habit for that day (made the first time). */
export async function checkRoutineHabit(routineName: string, date: string): Promise<void> {
  const all = habits(await db.memos.toArray());
  const found = all.find((m) => m.habit!.routineName === routineName) || all.find((m) => m.habit!.name === routineName);
  const memo = found || await createHabit(routineName, routineName);
  await setHabitDay(memo, date, true);
}

const normalize = (v: string) => v.normalize('NFKC').replace(/[\s　・、。]/g, '').toLowerCase();

/** 同じ名前のタスク（ルーティンのステップなど）を終えたら、その日の習慣に✓。 */
export async function checkHabitForTask(title: string, date: string): Promise<boolean> {
  const key = normalize(title);
  if (!key) return false;
  const found = habits(await db.memos.toArray()).find((m) => normalize(m.habit!.name) === key);
  if (!found || found.habit!.days.includes(date)) return false;
  await setHabitDay(found, date, true);
  return true;
}
