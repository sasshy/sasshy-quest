import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensureDefaults } from './db';
import { applyNativeTimerEvent } from './native-timer-events';
import { autoCutForgotten } from './StaleSession';
import { createTask, startFocusSession, updateSession } from './store';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe('自動の寄り道は静かな記録', () => {
  it('starts without any alarm message and without opening the timer', async () => {
    const posted: string[] = [];
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { sasshyAlarm: { postMessage: (m: { action: string }) => posted.push(m.action) } } };
    const opened = vi.fn();
    window.addEventListener('sasshy-open-timer', opened);
    const task = await createTask({ title: 'シャワー' });
    const main = await startFocusSession(task, 15);
    await updateSession(main.id, { startedAt: ago(3) }, 'test');
    posted.length = 0;
    await applyNativeTimerEvent({ id: 'd1', type: 'detour', taskId: 'X', at: new Date().toISOString() });
    const detour = (await db.sessions.toArray()).find((s) => s.interrupt);
    expect(detour?.interrupt?.auto).toBe(true);
    expect(detour?.status).toBe('running');
    expect(posted.filter((a) => a !== 'cancel')).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    delete (window as unknown as { webkit?: unknown }).webkit;
  });

  it('is closed after 30 minutes', async () => {
    const task = await createTask({ title: '資料' });
    const main = await startFocusSession(task, 15);
    await updateSession(main.id, { startedAt: ago(50) }, 'test');
    await applyNativeTimerEvent({ id: 'd2', type: 'detour', taskId: 'YouTube', at: ago(45) });
    await autoCutForgotten();
    const detour = (await db.sessions.toArray()).find((s) => s.interrupt);
    expect(detour?.status).toBe('completed');
    expect(Date.parse(detour!.endedAt!) - Date.parse(detour!.startedAt)).toBe(30 * 60_000);
  });
});
