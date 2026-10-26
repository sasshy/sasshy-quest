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
    expect(s.byCategory[0]).toEqual({ name: 'ネット通販', amount: 10771 });
    expect(spendCategory(memos.find((m) => m.expense?.item === '電車')!)).toBe('交通');
  });
});

describe('枠と使い道の振り分け', () => {
  it('病院・調剤薬局は予算の外、アイドラッグストアーはネット通販（買い物枠）', async () => {
    const day = '2026-10-26';
    await recordExpense({ item: 'JMC自由が丘メディカルクリニック 内科診療', amount: 1110, at: at(day) });
    await recordExpense({ item: '安藤薬局 処方薬・調剤', amount: 2860, at: at(day) });
    await recordExpense({ item: 'アイドラッグストアー 医薬品3点', amount: 10771, at: at(day) });
    await recordExpense({ item: 'ドーナツ', amount: 300, at: at(day) });
    const memos = await db.memos.toArray();
    const s = moneySummary(memos, DEFAULT_BUDGET, '2026-10-25', '2026-11-24');
    expect(s.outside).toBe(3970);
    expect(s.shopping).toBe(10771);
    expect(s.daily).toBe(300);
    const cat = (name: string) => spendCategory(memos.find((m) => m.expense?.item.startsWith(name))!);
    expect(cat('JMC')).toBe('医療');
    expect(cat('安藤薬局')).toBe('医療');
    expect(cat('アイドラッグ')).toBe('ネット通販');
  });
  it('レシートの支出にまとめた食事は二重に数えない', async () => {
    const day = '2026-10-23';
    const receipt = await recordExpense({ item: 'ファミリーマート', amount: 785, at: at(day) });
    const meal = await recordMeal({ kind: 'lunch', item: 'うどん', price: 213, at: at(day) });
    await db.memos.update(meal.id, { meal: { ...meal.meal!, receiptExpenseId: receipt.id } });
    const s = moneySummary(await db.memos.toArray(), DEFAULT_BUDGET, '2026-09-25', '2026-10-24');
    expect(s.total).toBe(785);
  });
});

import { checkHabitForTask, createHabit } from './habits';
describe('ルーティンのステップの習慣', () => {
  it('同じ名前のタスクを終えると習慣に✓', async () => {
    await createHabit('水虫の薬を塗る', null, '夜ルーティン');
    expect(await checkHabitForTask('水虫の薬を塗る', '2026-10-27')).toBe(true);
    const h = (await db.memos.toArray()).find((m) => m.habit?.name === '水虫の薬を塗る')!;
    expect(h.habit!.days).toEqual(['2026-10-27']);
    expect(await checkHabitForTask('シャワー', '2026-10-27')).toBe(false);
  });
});
