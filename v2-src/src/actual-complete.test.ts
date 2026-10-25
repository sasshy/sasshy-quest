import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { completeTaskFromActual, createManualFocusSession, createTask, startFocusSession } from './store';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe('実績を入れたら完了', () => {
  it('completes the task at the actual end time and drops a leftover running timer', async () => {
    const task = await createTask({ title: 'シャワー', scheduledDate: '2026-10-25' });
    const running = await startFocusSession(task, 15);
    const added = await createManualFocusSession(task, '2026-10-25T16:05:00+09:00', '2026-10-25T16:15:00+09:00');
    await completeTaskFromActual(task.id, added.endedAt!, added.id);
    const after = await db.tasks.get(task.id);
    expect(after?.status).toBe('done');
    expect(after?.completedAt).toBe(new Date('2026-10-25T16:15:00+09:00').toISOString());
    expect((await db.sessions.get(running.id))?.deletedAt).toBeTruthy();
    expect((await db.sessions.get(added.id))?.deletedAt).toBeFalsy();
  });
});
