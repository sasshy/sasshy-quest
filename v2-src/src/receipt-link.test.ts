import { describe, expect, it } from 'vitest';
import type { Memo } from './types';
import { findReceiptLinks } from './meals';

const base = { body: '', pinned: false, reminderAt: null, archived: false, deletedAt: null, source: 'v2', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', sync: { deviceId: 'x' } };
const exp = (id: string, item: string, amount: number) => ({ ...base, id, title: item, category: '支出', expense: { at: '2026-10-28T03:00:00.000Z', item, amount } }) as unknown as Memo;
const meal = (id: string, item: string, price: number, extra: object = {}) => ({ ...base, id, title: item, category: '食事', meal: { at: '2026-10-28T03:30:00.000Z', item, kind: 'lunch', price, ...extra } }) as unknown as Memo;

describe('レシートと食事の二重計上', () => {
  it('レシートに「◯円」とある食事・同じ金額の食事を結びつける', () => {
    const memos = [
      exp('r1', 'ローソン もちどーきなこ171円＋チーズタルト297円（レシート）', 468),
      meal('m1', 'もちどー きなこ', 171),
      meal('m2', 'チーズタルト', 297),
      exp('r2', '三鷹ベイビーチキン 飲み会', 3500),
      meal('m3', '飲み会', 3500),
    ];
    expect(findReceiptLinks(memos)).toEqual([
      { mealId: 'm1', expenseId: 'r1' },
      { mealId: 'm2', expenseId: 'r1' },
      { mealId: 'm3', expenseId: 'r2' },
    ]);
  });
  it('払った額が書いてある食事・家ごはん・関係ない金額はそのまま', () => {
    const memos = [exp('r1', 'ファミマ 弁当', 500), meal('m1', '弁当', 500, { paid: 500 }), meal('m2', 'みそ汁', 500, { payment: 'home' }), meal('m3', 'おにぎり', 160)];
    expect(findReceiptLinks(memos)).toEqual([]);
  });
});
