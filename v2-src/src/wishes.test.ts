import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { recordMeal, updateMeal } from './meals';
import { addAttempt, areaOf, canPin, createWish, pinnedWishes, saveArea, updateWish } from './wishes';
import { starterPlannedMin } from './TwoMinute';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe('wishes', () => {
  it('counts tries and keeps at most 3 pinned', async () => {
    for (const t of ['映画', '旅行', '貯金', '料理']) await createWish(t, true);
    let memos = await db.memos.toArray();
    expect(pinnedWishes(memos)).toHaveLength(3);
    const fourth = memos.find((m) => m.title === '料理')!;
    await updateWish(fourth, { pinned: false });
    memos = await db.memos.toArray();
    expect(canPin(memos, memos.find((m) => m.title === '料理')!)).toBe(false);
    const movie = memos.find((m) => m.title === '映画')!;
    await addAttempt(movie, '1本観た');
    expect((await db.memos.get(movie.id))!.wish!.attempts).toEqual([expect.objectContaining({ note: '1本観た' })]);
  });

  it('keeps one card per life area', async () => {
    await saveArea([], 'money', { state: '赤字ぎみ', next: '書類', tone: 'watch' });
    await saveArea(await db.memos.toArray(), 'money', { state: '少し改善', next: '', tone: 'good' });
    const memos = await db.memos.toArray();
    expect(memos.filter((m) => m.area)).toHaveLength(1);
    expect(areaOf(memos, 'money')!.area).toMatchObject({ state: '少し改善', tone: 'good' });
  });
});

describe('fixing a meal record', () => {
  it('changes name, price and payment and keeps nutrition', async () => {
    const memo = await recordMeal({ kind: 'lunch', item: 'おにぎり', price: 150, kcal: 180 });
    await updateMeal(memo.id, { kind: 'dinner', item: '鮭おにぎり', price: 160, at: memo.meal!.at, place: 'ローソン', payment: 'treated', paid: null });
    const fixed = (await db.memos.get(memo.id))!;
    expect(fixed.meal).toMatchObject({ kind: 'dinner', item: '鮭おにぎり', price: 160, kcal: 180, place: 'ローソン', payment: 'treated', paid: 0 });
    expect(fixed.title).toContain('鮭おにぎり');
  });
});

describe('2分だけ', () => {
  it('runs two more minutes on top of earlier work', () => {
    expect(starterPlannedMin(0)).toBe(2);
    expect(starterPlannedMin(610)).toBe(13);
  });
});
