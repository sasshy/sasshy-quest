import { db } from './db';
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

/** Newest first, one per day (if a day got several, the latest edit wins). */
export function diaryEntries(memos: Memo[], sinceKey?: string): Memo[] {
  const byDay = new Map<string, Memo>();
  for (const m of memos) {
    if (m.deletedAt || m.archived || !isDiaryMemo(m) || (sinceKey && m.diary!.date < sinceKey)) continue;
    const seen = byDay.get(m.diary!.date);
    if (!seen || Date.parse(m.updatedAt) > Date.parse(seen.updatedAt)) byDay.set(m.diary!.date, m);
  }
  return [...byDay.values()].sort((a, b) => b.diary!.date.localeCompare(a.diary!.date));
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

export async function saveDiary(_memos: Memo[], dateKey: string, changes: { text?: string; mood?: number | null }): Promise<Memo | null> {
  // 画面が持っている一覧は古いことがある（それで同じ日の日記が何件もできていた）ので、保存先から読み直す。
  const existing = diaryOn(await db.memos.toArray(), dateKey);
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

/** 同じ日に日記がいくつもできていたら、本文のある一番新しいものだけ残してしまう（消さない）。 */
export async function tidyDiaryDuplicates(): Promise<number> {
  const all = (await db.memos.toArray()).filter((m) => !m.deletedAt && !m.archived && isDiaryMemo(m));
  const byDay = new Map<string, Memo[]>();
  for (const m of all) byDay.set(m.diary!.date, [...(byDay.get(m.diary!.date) || []), m]);
  let archived = 0;
  for (const list of byDay.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => Number(Boolean(b.body.trim())) - Number(Boolean(a.body.trim())) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const keep = sorted[0];
    const mood = keep.diary!.mood ?? sorted.find((m) => m.diary!.mood !== null && m.diary!.mood !== undefined)?.diary!.mood ?? null;
    if (mood !== keep.diary!.mood) await updateMemo(keep.id, { diary: { ...keep.diary!, mood } }, '日記の気分をまとめる');
    for (const extra of sorted.slice(1)) {
      await updateMemo(extra.id, { archived: true }, '同じ日の日記をひとつにまとめる');
      archived += 1;
    }
  }
  return archived;
}
