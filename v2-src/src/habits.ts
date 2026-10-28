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

/** しまった習慣（記録は残っている）。編集画面から戻す・消すができる。 */
export function archivedHabits(memos: Memo[]): Memo[] {
  return memos
    .filter((m) => !m.deletedAt && m.archived && isHabitMemo(m))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function restoreHabit(memo: Memo): Promise<Memo | null> {
  return updateMemo(memo.id, { archived: false }, `習慣「${memo.habit!.name}」を戻す`);
}

/** 消す（同期で他の端末からも消える）。記録ごと要らないとき用。 */
export async function deleteHabit(memo: Memo): Promise<Memo | null> {
  return updateMemo(memo.id, { deletedAt: new Date().toISOString() }, `習慣「${memo.habit!.name}」を消す`);
}

export const countIn = (memo: Memo, prefix: string) => memo.habit!.days.filter((d) => d.startsWith(prefix)).length;

/**
 * A routine was finished: check a habit only if the user made one for that
 * routine. A routine itself is never turned into a habit automatically.
 */
export async function checkRoutineHabit(routineName: string, date: string): Promise<void> {
  const found = habits(await db.memos.toArray()).find((m) => m.habit!.routineName === routineName && !m.habit!.auto);
  if (found) await setHabitDay(found, date, true);
}

/** 以前、ルーティンを終えたときに自動で作っていた「ルーティン名の習慣」をしまう（記録は残る）。 */
export async function tidyRoutineHabits(routineNames: string[]): Promise<number> {
  const names = new Set(routineNames);
  const made = habits(await db.memos.toArray()).filter((m) => names.has(m.habit!.name) && m.habit!.routineName === m.habit!.name);
  for (const m of made) await archiveHabit(m);
  return made.length;
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

/**
 * 1回だけ：頼まれていた「水虫の薬を塗る」を習慣にして、夜ルーティンの最後にも入れる。
 * 動作確認用の「テスト」「テスト2」はしまう。iPhoneアプリでだけ動かす（二重に作らないため）。
 */
export async function setupRequestedHabitsOnce(
  routines: { id: string; name: string; steps: { title: string; minutes: number }[] }[],
  save: (list: typeof routines) => Promise<void>,
): Promise<boolean> {
  const KEY = 'sasshy-habit-setup-mizumushi';
  const native = Boolean((window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: unknown } } }).webkit?.messageHandlers?.sasshyAlarm);
  try {
    if (!native || localStorage.getItem(KEY)) return false;
    localStorage.setItem(KEY, '1');
  } catch {
    return false;
  }
  const NAME = '水虫の薬を塗る';
  const all = await db.memos.toArray();
  let changed = false;
  if (!all.some((m) => isHabitMemo(m) && !m.deletedAt && m.habit!.name.includes('水虫'))) {
    await createHabit(NAME, null, '夜ルーティン');
    changed = true;
  }
  const night = routines.find((r) => r.name === '夜ルーティン');
  if (night && !night.steps.some((s) => s.title.includes('水虫'))) {
    await save(routines.map((r) => (r.id === night.id ? { ...r, steps: [...r.steps, { title: NAME, minutes: 2 }] } : r)));
    changed = true;
  }
  for (const m of habits(all)) {
    if (/^テスト\d*$/.test(m.habit!.name)) { await archiveHabit(m); changed = true; }
  }
  return changed;
}

/**
 * 1回だけ：「お昼と間食 800円以内」を自動の習慣として作る（9〜17時の食費の合計で判定）。
 * 表がすぐ埋まるように、1週間前から数える。iPhoneアプリでだけ動かす。
 */
export async function setupLunchHabitOnce(): Promise<boolean> {
  const KEY = 'sasshy-habit-setup-lunch800';
  const native = Boolean((window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: unknown } } }).webkit?.messageHandlers?.sasshyAlarm);
  try {
    if (!native || localStorage.getItem(KEY)) return false;
    localStorage.setItem(KEY, '1');
  } catch {
    return false;
  }
  const all = await db.memos.toArray();
  if (all.some((m) => isHabitMemo(m) && !m.deletedAt && m.habit!.rule?.kind === 'daytimeFood')) return false;
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const name = 'お昼と間食 800円以内';
  await createMemo({
    title: `習慣：${name}`,
    body: '',
    category: HABIT_CATEGORY,
    habit: { name, days: [], routineName: null, rule: { kind: 'daytimeFood', limit: 800, fromHour: 9, toHour: 17 }, startDate },
  });
  return true;
}
