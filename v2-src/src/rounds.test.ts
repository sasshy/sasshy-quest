import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { createTask, startFocusSession, updateSession } from './store';
import { nextRound, planSuggestions, usesRounds } from './rounds';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe('15-minute rounds', () => {
  it('splits a long task into rounds, the last one shorter', async () => {
    const task = await createTask({ title: '出荷の梱包', estimateMin: 40, durationMin: 40 });
    expect(usesRounds(task)).toBe(true);
    expect(nextRound(task, 0)).toMatchObject({ plannedMin: 15, round: { index: 1, total: 3 } });
    expect(nextRound(task, 30 * 60)).toMatchObject({ plannedMin: 40, round: { index: 3, total: 3 } });
    expect(usesRounds(await createTask({ title: '返信', estimateMin: 10 }))).toBe(false);
  });

  it('suggests the unfinished plan first, then the steps used last time for the same kind of task', async () => {
    const before = await createTask({ title: '出荷の梱包', estimateMin: 45 });
    for (const [i, plan] of ['伝票を出す', '箱を組む', '詰める'].entries()) {
      const s = await startFocusSession(before, 15, i * 900, { round: { index: i + 1, total: 3, plan } });
      await updateSession(s.id, { status: 'interrupted', endedAt: new Date().toISOString() }, 'test');
    }
    const today = await createTask({ title: '出荷の梱包', estimateMin: 45 });
    const current = await startFocusSession(today, 15, 0, { round: { index: 1, total: 3, plan: '伝票を出す', result: 'half' } });
    expect(await planSuggestions(today, current)).toEqual(['伝票を出す', '箱を組む', '詰める']);
  });
});

describe('detour from the iPhone shortcut', () => {
  it('ends the work when X was opened and times the detour from then', async () => {
    const { startInterruptAt, detourKind } = await import('./rounds');
    const task = await createTask({ title: '梱包', estimateMin: 15 });
    const work = await startFocusSession(task, 15);
    const at = Date.parse(work.startedAt) + 4 * 60_000;
    const detour = await startInterruptAt(detourKind('X'), 'X', at);
    expect(detour).toMatchObject({ startedAt: new Date(at).toISOString(), interrupt: { kind: 'detour', returnTaskId: task.id, returnLeftMin: 11 } });
    expect((await db.sessions.get(work.id))!).toMatchObject({ status: 'interrupted', endedAt: new Date(at).toISOString() });
    expect(detourKind('kintone')).toBe('interrupt');
  });
});
