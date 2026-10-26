import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { addPlannedSpend, budgetPeriod, budgetStatus, DEFAULT_BUDGET, isPlannedMemo, isShoppingExpense, markPlannedSpent, shoppingStatus } from './budget';
import { updateExpense } from './meals';
import { isLedgerMemo, recordExpense, recordMeal } from './meals';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

const at = (day: string, hm = '12:00') => new Date(`${day}T${hm}:00`).toISOString();

describe('pay period', () => {
  it('runs from payday to the day before the next payday', () => {
    expect(budgetPeriod('2026-10-22', 25)).toEqual({ start: '2026-09-25', end: '2026-10-24', days: 30 });
    expect(budgetPeriod('2026-10-25', 25)).toEqual({ start: '2026-10-25', end: '2026-11-24', days: 31 });
    expect(budgetPeriod('2026-01-10', 25).start).toBe('2025-12-25');
    expect(budgetPeriod('2026-10-22', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31', days: 31 });
  });
});

describe('今日あと使える', () => {
  it('spreads what is left (after planned spends) over the remaining days', async () => {
    // period 10/01–10/31, today 10/22 → 10 days left including today
    await recordMeal({ kind: 'lunch', item: '定食', price: 10000, at: at('2026-10-05') });
    await recordExpense({ item: 'タクシー', amount: 1000, at: at('2026-10-21') });
    await addPlannedSpend({ item: '美容院', amount: 4000 });
    await recordMeal({ kind: 'lunch', item: 'そば', price: 500, at: at('2026-10-22') });
    const s = budgetStatus(await db.memos.toArray(), { ...DEFAULT_BUDGET, amount: 30000, startDay: 1 }, '2026-10-22');
    expect(s.spentBefore).toBe(11000);
    expect(s.planned).toBe(4000);
    expect(s.daysLeft).toBe(10);
    expect(s.todayAllowance).toBe(1500); // (30000 − 11000 − 4000) / 10
    expect(s.todayLeft).toBe(1000);
    expect(s.periodLeft).toBe(14500);
  });

  it('a planned spend marked as used is counted once, as a spend', async () => {
    const plan = await addPlannedSpend({ item: '美容院', amount: 4000 });
    expect(isPlannedMemo(plan)).toBe(true);
    expect(isLedgerMemo(plan)).toBe(true); // hidden from the memo list
    await markPlannedSpent(plan, 3800);
    const memos = await db.memos.toArray();
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const s = budgetStatus(memos, { ...DEFAULT_BUDGET, amount: 30000, startDay: 1 }, key);
    expect(s.planned).toBe(0);
    expect(s.spentToday).toBe(3800);
  });

  it('planned spends dated outside the period are not subtracted', async () => {
    await addPlannedSpend({ item: '旅行', amount: 20000, date: '2026-12-01' });
    const s = budgetStatus(await db.memos.toArray(), { ...DEFAULT_BUDGET, startDay: 1 }, '2026-10-22');
    expect(s.planned).toBe(0);
  });
});

describe('買い物枠', () => {
  it('Amazon・ドラッグストアは買い物枠に入り、今日の「あと使える」を減らさない', async () => {
    const today = '2026-10-26';
    await recordExpense({ item: 'アイドラッグストアー まとめ買い', amount: 10771, at: at(today) });
    await recordExpense({ item: 'idrugstore', amount: 500, at: at(today) });
    await recordExpense({ item: 'コンビニ コーヒー', amount: 150, at: at(today) });
    const memos = await db.memos.toArray();
    const daily = budgetStatus(memos, DEFAULT_BUDGET, today);
    expect(daily.spentToday).toBe(150);
    const shop = shoppingStatus(memos, DEFAULT_BUDGET, today);
    expect(shop.spent).toBe(11271);
    expect(shop.left).toBe(20000 - 11271);
  });
  it('記録ごとに枠を変えられる', async () => {
    const m = await recordExpense({ item: 'Amazon 本', amount: 1200, at: at('2026-10-26') });
    expect(isShoppingExpense(m)).toBe(true);
    const changed = await updateExpense(m.id, { item: 'Amazon 本', amount: 1200, at: m.expense!.at, bucket: 'daily' });
    expect(isShoppingExpense(changed!)).toBe(false);
  });
});
