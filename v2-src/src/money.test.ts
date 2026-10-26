import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { DEFAULT_BUDGET } from './budget';
import { recordExpense, recordMeal } from './meals';
import { moneySummary, periodAt, recordIncome, spendCategory } from './money';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

const at = (day: string) => new Date(`${day}T12:00:00`).toISOString();

describe('記録 › お金', () => {
  it('給料日期間を前後にずらせる', () => {
    expect(periodAt('2026-10-26', 25, 0)).toEqual({ start: '2026-10-25', end: '2026-11-24' });
    expect(periodAt('2026-10-26', 25, -1)).toEqual({ start: '2026-09-25', end: '2026-10-24' });
    expect(periodAt('2026-10-26', 25, -2).start).toBe('2026-08-25');
  });
  it('合計・2つの枠・使い道・収支をまとめる', async () => {
    await recordExpense({ item: 'アイドラッグストアー', amount: 10771, at: at('2026-10-26') });
    await recordExpense({ item: '電車', amount: 220, at: at('2026-10-27') });
    await recordMeal({ kind: 'lunch', item: 'ランチ', price: 980, at: at('2026-10-26') });
    await recordExpense({ item: '先月の分', amount: 999, at: at('2026-10-20') });
    await recordIncome({ item: '給料', amount: 250000, at: at('2026-10-25') });
    const memos = await db.memos.toArray();
    const s = moneySummary(memos, DEFAULT_BUDGET, '2026-10-25', '2026-11-24');
    expect(s.total).toBe(11971);
    expect(s.shopping).toBe(10771);
    expect(s.daily).toBe(1200);
    expect(s.income).toBe(250000);
    expect(s.byCategory[0]).toEqual({ name: 'ドラッグストア', amount: 10771 });
    expect(spendCategory(memos.find((m) => m.expense?.item === '電車')!)).toBe('交通');
  });
});
