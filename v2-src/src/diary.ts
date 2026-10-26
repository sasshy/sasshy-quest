import { createMemo, updateMemo } from './store';
import type { Memo } from './types';
import { companionMoment } from './companion-events';

/**
 * ひとこと日記: one short entry per day with an optional mood (1..5).
 * Stored as a memo (category 日記) so it syncs like everything else.
 */
export const DIARY_CATEGORY = '日記';
export const MOOD_LABEL = ['', 'しんどい', 'いまいち', 'ふつう', 'いい', '最高'];

export function isDiaryMemo(memo: Memo): boolean {
  return memo.category === DIARY_CATEGORY && Boolean(memo.diary?.date);
}

export function diaryOn(memos: Memo[], dateKey: string): Memo | null {
  return memos
    .filter((m) => !m.deletedAt && !m.archived && isDiaryMemo(m) && m.diary!.date === dateKey)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
}

/** Newest first. */
export function diaryEntries(memos: Memo[], sinceKey?: string): Memo[] {
  return memos
    .filter((m) => !m.deletedAt && !m.archived && isDiaryMemo(m) && (!sinceKey || m.diary!.date >= sinceKey))
    .sort((a, b) => b.diary!.date.localeCompare(a.diary!.date));
}

/** A different small question each day, so it never feels like the same form. */
const PROMPTS = [
  '今日よかったことを1つ',
  '今日ちょっと進んだこと',
  '明日の自分にひとこと',
  '今日いちばん楽しかった瞬間',
  '今日の自分をひとことで',
  '気になっていること（書けば頭から出せる）',
  'やってみたいと思ったこと',
];
export function diaryPrompt(dateKey: string): string {
  const n = dateKey.split('-').reduce((sum, part) => sum + Number(part), 0);
  return PROMPTS[n % PROMPTS.length];
}

const titleOf = (dateKey: string, text: string) => {
  const d = new Date(`${dateKey}T12:00:00`);
  const head = `${d.getMonth() + 1}/${d.getDate()}の日記`;
  const first = text.split(/\r?\n/)[0].trim();
  return first ? `${head}：${first.slice(0, 30)}` : head;
};

export async function saveDiary(memos: Memo[], dateKey: string, changes: { text?: string; mood?: number | null }): Promise<Memo | null> {
  const existing = diaryOn(memos, dateKey);
  const text = (changes.text ?? existing?.body ?? '').trim().slice(0, 2000);
  const mood = changes.mood !== undefined ? changes.mood : existing?.diary?.mood ?? null;
  if (existing) {
    return updateMemo(existing.id, { body: text, title: titleOf(dateKey, text), diary: { date: dateKey, mood } }, '日記を更新');
  }
  if (!text && mood === null) return null;
  const created = await createMemo({ title: titleOf(dateKey, text), body: text, category: DIARY_CATEGORY, diary: { date: dateKey, mood } });
  companionMoment('diary');
  return created;
}
