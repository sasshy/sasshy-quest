import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import {
  createTask, discardFocusSession, resumeFocusSession, restartFocusSession, startFocusSession, stopFocusSessionAt, updateSession,
} from './store';
import { taskWorkedSeconds } from './insights';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe('timer correction (forgot to stop / start over)', () => {
  it('stops the timer at a past time and does not count the time since then', async () => {
    const task = await createTask({ title: '机の片付け', estimateMin: 15 });
    const started = await startFocusSession(task, 15);
    await updateSession(started.id, { startedAt: minutesAgo(50) }, 'test: started 50 min ago');

    const stopped = await stopFocusSessionAt(started.id, minutesAgo(40));
    expect(stopped?.status).toBe('paused');

    // Resuming now adds the 40 forgotten minutes to the paused time, so only ~10 minutes count.
    const resumed = await resumeFocusSession(started.id);
    expect(resumed?.status).toBe('running');
    expect(resumed!.pausedTotalSec).toBeGreaterThanOrEqual(40 * 60 - 2);
    await updateSession(started.id, { status: 'completed', endedAt: new Date().toISOString(), pausedAt: null }, 'test: complete now');
    const sessions = await db.sessions.toArray();
    const worked = taskWorkedSeconds(task.id, sessions);
    expect(worked).toBeGreaterThanOrEqual(10 * 60 - 2);
    expect(worked).toBeLessThanOrEqual(10 * 60 + 2);
  });

  it('rejects a stop time before the start or in the future', async () => {
    const task = await createTask({ title: '発注' });
    const started = await startFocusSession(task, 5);
    await expect(stopFocusSessionAt(started.id, minutesAgo(10))).rejects.toThrow('開始した時刻より前');
    await expect(stopFocusSessionAt(started.id, new Date(Date.now() + 60_000).toISOString())).rejects.toThrow('今より後');
  });

  it('can move an existing pause earlier but not later', async () => {
    const task = await createTask({ title: '出荷準備' });
    const started = await startFocusSession(task, 30);
    await updateSession(started.id, { startedAt: minutesAgo(60), status: 'paused', pausedAt: minutesAgo(20) }, 'test');
    expect((await stopFocusSessionAt(started.id, minutesAgo(45)))?.pausedAt).toBe((await db.sessions.get(started.id))!.pausedAt);
    await expect(stopFocusSessionAt(started.id, minutesAgo(5))).rejects.toThrow('すでに一時停止した時刻より後');
  });

  it('starts over: the old attempt is dropped and a fresh timer runs with the same length', async () => {
    const task = await createTask({ title: 'LP-VP3の組み付け', estimateMin: 20 });
    const first = await startFocusSession(task, 25);
    const second = await restartFocusSession(first.id);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    expect(second!.status).toBe('running');
    expect(second!.plannedMin).toBe(25);
    const old = await db.sessions.get(first.id);
    expect(old?.deletedAt).toBeTruthy();
    expect(old?.status).toBe('interrupted');
    const live = (await db.sessions.toArray()).filter((s) => !s.deletedAt && (s.status === 'running' || s.status === 'paused'));
    expect(live.map((s) => s.id)).toEqual([second!.id]);
  });

  it('discards a timer that was started by mistake (kept in history, queued for sync)', async () => {
    const task = await createTask({ title: '間違えて開始' });
    const started = await startFocusSession(task, 5);
    await discardFocusSession(started.id);
    const after = await db.sessions.get(started.id);
    expect(after?.deletedAt).toBeTruthy();
    expect(after?.status).toBe('interrupted');
    expect((await db.outbox.toArray()).filter((row) => row.entityId === started.id).length).toBeGreaterThan(0);
  });
});
