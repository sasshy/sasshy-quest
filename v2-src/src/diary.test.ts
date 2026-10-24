import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { diaryEntries, diaryOn, saveDiary } from './diary';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe('diary', () => {
  it('keeps one entry per day and updates it in place', async () => {
    await saveDiary(await db.memos.toArray(), '2026-10-24', { mood: 4 });
    await saveDiary(await db.memos.toArray(), '2026-10-24', { text: '食事画面がきれいになった' });
    const memos = await db.memos.toArray();
    const entry = diaryOn(memos, '2026-10-24');
    expect(entry).toMatchObject({ body: '食事画面がきれいになった', diary: { date: '2026-10-24', mood: 4 } });
    expect(diaryEntries(memos)).toHaveLength(1);
  });

  it('does not create an empty entry', async () => {
    expect(await saveDiary([], '2026-10-24', { text: '  ' })).toBeNull();
  });
});
