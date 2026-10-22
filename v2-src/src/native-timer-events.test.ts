import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { applyNativeTimerEvent } from './native-timer-events';
import { createTask, startFocusSession, updateSession } from './store';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe('lock-screen alarm actions reach the app timer', () => {
  it('"ここで止める" pauses the timer at that time (not completed)', async () => {
    const task = await createTask({ title: '出荷準備' });
    const session = await startFocusSession(task, 15);
    await updateSession(session.id, { startedAt: ago(60) }, 'test');
    await applyNativeTimerEvent({ id: 'e1', type: 'stopped', taskId: session.id, at: ago(44) });
    const after = await db.sessions.get(session.id);
    expect(after?.status).toBe('paused');
    expect(Math.abs(Date.parse(after!.pausedAt!) - Date.parse(ago(44)))).toBeLessThan(2000);
    expect((await db.tasks.get(task.id))?.status).not.toBe('done');
  });

  it('"10分延長" makes the app timer end 10 minutes after the tap', async () => {
    const task = await createTask({ title: '組み付け' });
    const session = await startFocusSession(task, 15);
    await updateSession(session.id, { startedAt: ago(16) }, 'test');
    await applyNativeTimerEvent({ id: 'e2', type: 'extended', taskId: session.id, at: ago(1), seconds: 600 });
    expect((await db.sessions.get(session.id))?.plannedMin).toBe(25);
  });

  it('ignores repeats and events for timers that already ended', async () => {
    const task = await createTask({ title: '片付け' });
    const session = await startFocusSession(task, 10);
    await updateSession(session.id, { startedAt: ago(30) }, 'test');
    const event = { id: 'e3', type: 'extended' as const, taskId: session.id, at: ago(0), seconds: 600 };
    await applyNativeTimerEvent(event);
    await applyNativeTimerEvent(event);
    expect((await db.sessions.get(session.id))?.plannedMin).toBe(40);
    await updateSession(session.id, { status: 'completed', endedAt: new Date().toISOString() }, 'test');
    await applyNativeTimerEvent({ id: 'e4', type: 'stopped', taskId: session.id, at: ago(0) });
    expect((await db.sessions.get(session.id))?.status).toBe('completed');
  });
});

describe('routine link from a widget / Siri', () => {
  it('starts the routine by id, but not on top of a running timer', async () => {
    await applyNativeTimerEvent({ id: 'r1', type: 'routine', taskId: 'night', at: new Date().toISOString() });
    const sessions = await db.sessions.toArray();
    expect(sessions).toHaveLength(1);
    expect((await db.tasks.get(sessions[0].taskId))?.title).toBe('シャワー');
    await applyNativeTimerEvent({ id: 'r2', type: 'routine', taskId: 'night', at: new Date().toISOString() });
    expect(await db.sessions.count()).toBe(1);
  });

  it('ignores an old queued tap', async () => {
    await applyNativeTimerEvent({ id: 'r3', type: 'routine', taskId: 'night', at: ago(30) });
    expect(await db.sessions.count()).toBe(0);
  });
});
