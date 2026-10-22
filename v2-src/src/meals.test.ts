import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { createMemo } from './store';
import {
  expenseTotalOn, isLedgerMemo, ledgerOn, localDateKey, mealsOn, paidAmount, parseMealPaste, recordExpense, recordMeal,
  removeMeal, shiftDateKey, spendOn, valueOn, walletOn,
} from './meals';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

const day = '2026-10-21';
const at = (hm: string) => new Date(`${day}T${hm}:00`).toISOString();

describe('meal records', () => {
  it('records a meal as a hidden memo and totals what was paid, not the price', async () => {
    await recordMeal({ kind: 'lunch', item: '唐揚げ弁当', price: 600, at: at('12:10') });
    await recordMeal({ kind: 'dinner', item: '居酒屋', price: 3000, payment: 'split', paid: 1000, at: at('20:00') });
    await recordMeal({ kind: 'snack', item: 'もらったお菓子', price: 300, payment: 'treated', at: at('15:00') });
    const memos = await db.memos.toArray();
    expect(memos.every(isLedgerMemo)).toBe(true);
    expect(mealsOn(memos, day).map((m) => m.meal!.item)).toEqual(['唐揚げ弁当', 'もらったお菓子', '居酒屋']);
    expect(spendOn(memos, day)).toBe(600 + 0 + 1000);
    expect(valueOn(memos, day)).toBe(3900);
  });

  it('paidAmount falls back to price, and to 0 when treated', () => {
    expect(paidAmount({ kind: 'lunch', item: 'a', price: 500, at: at('12:00') })).toBe(500);
    expect(paidAmount({ kind: 'lunch', item: 'a', price: 500, payment: 'treated', at: at('12:00') })).toBe(0);
    expect(paidAmount({ kind: 'lunch', item: 'a', price: null, at: at('12:00') })).toBe(0);
  });

  it('reads the pasted AI answer (code block, several items)', () => {
    const items = parseMealPaste('```\nSASSHY食事\n昼食|鮭おにぎり|160|180|5|2|38|レシート|ローソン\n昼食|唐揚げ 3個|250|300|15|20|12|推測|ローソン\n```', 'snack');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'lunch', item: '鮭おにぎり', price: 160, kcal: 180, priceSource: 'receipt', place: 'ローソン' });
    expect(items[1]).toMatchObject({ item: '唐揚げ 3個', price: 250, priceSource: 'estimate' });
  });

  it('a removed meal is no longer counted', async () => {
    const meal = await recordMeal({ kind: 'lunch', item: 'そば', price: 500, at: at('12:00') });
    await removeMeal(meal.id);
    expect(spendOn(await db.memos.toArray(), day)).toBe(0);
  });
});

describe('other spends (taxi etc.)', () => {
  it('keeps spends out of the memo list and counts each record once in the day total', async () => {
    await recordMeal({ kind: 'lunch', item: '定食', price: 900, at: at('12:30') });
    await recordExpense({ item: 'タクシー', amount: 500, at: at('08:40') });
    const memos = await db.memos.toArray();
    expect(memos.every(isLedgerMemo)).toBe(true);
    expect(expenseTotalOn(memos, day)).toBe(500);
    expect(walletOn(memos, day)).toBe(1400);
    expect(ledgerOn(memos, day).map((m) => m.meal?.item || m.expense?.item)).toEqual(['タクシー', '定食']);
  });

  it('understands the shape ChatGPT already saved (extra keys kept)', async () => {
    await createMemo({
      title: '通勤タクシー', body: '', category: '支出',
      expense: { item: '通勤タクシー', amount: 500, at: at('08:30'), kind: 'transport', paymentMethod: 'cash', reimbursementStatus: 'none' },
    });
    const memos = await db.memos.toArray();
    expect(isLedgerMemo(memos[0])).toBe(true);
    expect(walletOn(memos, day)).toBe(500);
    expect(memos[0].expense!.paymentMethod).toBe('cash');
  });

  it('a normal memo with category 支出 but no amount stays a normal memo', async () => {
    await createMemo({ title: '来月の支出を見直す', body: '', category: '支出' });
    expect(isLedgerMemo((await db.memos.toArray())[0])).toBe(false);
  });

  it('rejects a spend without amount', async () => {
    await expect(recordExpense({ item: 'タクシー', amount: null })).rejects.toThrow('金額');
  });
});

describe('day navigation', () => {
  it('moves across month ends', () => {
    expect(shiftDateKey('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(localDateKey(new Date(2026, 9, 22, 23, 59))).toBe('2026-10-22');
  });
});
