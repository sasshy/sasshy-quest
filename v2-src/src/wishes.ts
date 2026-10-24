import { createMemo, updateMemo } from './store';
import type { Memo, WishInfo, AreaInfo, AreaKey } from './types';

/**
 * やりたいこと: the user's own list. What is counted is "tries" (attempts),
 * not success, so a wish never turns into a silent failure. Up to 3 can be
 * pinned to the top of the map. Stored as memos so they sync.
 */
export const WISH_CATEGORY = 'やりたいこと';
export const AREA_CATEGORY = '領域';
export const MAX_PINNED = 3;

export function isWishMemo(memo: Memo): boolean {
  return memo.category === WISH_CATEGORY && Boolean(memo.wish);
}
export function isAreaMemo(memo: Memo): boolean {
  return memo.category === AREA_CATEGORY && Boolean(memo.area);
}

export function wishes(memos: Memo[]): Memo[] {
  return memos
    .filter((m) => !m.deletedAt && !m.archived && isWishMemo(m))
    .sort((a, b) => Number(b.wish!.pinned) - Number(a.wish!.pinned) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function pinnedWishes(memos: Memo[]): Memo[] {
  return wishes(memos).filter((m) => m.wish!.pinned && m.wish!.status === 'active').slice(0, MAX_PINNED);
}

export async function createWish(title: string, pinned = false): Promise<Memo> {
  const text = title.trim();
  if (!text) throw new Error('やりたいことを書いてください');
  const wish: WishInfo = { status: 'active', pinned, target: null, next: '', attempts: [] };
  return createMemo({ title: text.slice(0, 80), body: '', category: WISH_CATEGORY, wish });
}

export async function updateWish(memo: Memo, changes: Partial<WishInfo> & { title?: string; body?: string }): Promise<Memo | null> {
  const { title, body, ...wishChanges } = changes;
  const wish: WishInfo = { ...memo.wish!, ...wishChanges };
  return updateMemo(memo.id, {
    wish,
    ...(title !== undefined ? { title: title.trim().slice(0, 80) || memo.title } : {}),
    ...(body !== undefined ? { body: body.trim().slice(0, 4000) } : {}),
  }, 'やりたいことを更新');
}

/** Count one try (with an optional note). */
export async function addAttempt(memo: Memo, note = '', at = new Date().toISOString()): Promise<Memo | null> {
  const attempts = [...memo.wish!.attempts, { at, note: note.trim().slice(0, 200) }];
  return updateWish(memo, { attempts });
}

export async function removeAttempt(memo: Memo, index: number): Promise<Memo | null> {
  return updateWish(memo, { attempts: memo.wish!.attempts.filter((_, i) => i !== index) });
}

/** Pin to the map top; at most MAX_PINNED. Returns an error message when full. */
export function canPin(memos: Memo[], memo: Memo): boolean {
  return memo.wish!.pinned || pinnedWishes(memos).length < MAX_PINNED;
}

export const AREA_KEYS: AreaKey[] = ['money', 'work', 'family', 'health', 'fun', 'people'];
export const AREA_LABEL: Record<AreaKey, string> = { money: 'お金', work: '仕事', family: '家族', health: '健康', fun: '楽しみ', people: '人' };

export function areaOf(memos: Memo[], key: AreaKey): Memo | null {
  return memos
    .filter((m) => !m.deletedAt && isAreaMemo(m) && m.area!.key === key)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
}

export async function saveArea(memos: Memo[], key: AreaKey, changes: Omit<AreaInfo, 'key'>): Promise<Memo | null> {
  const existing = areaOf(memos, key);
  const area: AreaInfo = { key, state: changes.state.trim().slice(0, 120), next: changes.next.trim().slice(0, 120), tone: changes.tone };
  const title = `${AREA_LABEL[key]}：${area.state || '未記入'}`;
  if (existing) return updateMemo(existing.id, { area, title }, `${AREA_LABEL[key]}の状態を更新`);
  return createMemo({ title, body: '', category: AREA_CATEGORY, area });
}
