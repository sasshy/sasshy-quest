import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { createTask, startFocusSession } from './store';
import { autoCutForgotten, isStale, plannedEndMs } from './StaleSession';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe('forgotten timer', () => {
  it('asks after running far over, and cuts at the planned end after 2 hours over', async () => {
    const task = await createTask({ title: '梱包', estimateMin: 15, durationMin: 15 });
    const session = await startFocusSession(task, 15);
    const start = Date.parse(session.startedAt);
    expect(isStale(session, start + 30 * 60_000)).toBe(false);
    expect(isStale(session, start + 40 * 60_000)).toBe(true);
    expect(await autoCutForgotten(start + 60 * 60_000)).toHaveLength(0);
    const [cut] = await autoCutForgotten(start + 3 * 60 * 60_000);
    expect(cut).toMatchObject({ status: 'interrupted', autoStopped: true });
    expect(Date.parse(cut.endedAt!)).toBe(plannedEndMs(session));
  });
});
