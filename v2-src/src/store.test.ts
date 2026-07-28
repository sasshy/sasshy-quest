import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import {
  completeTask, createTask, pauseFocusSession, restoreTask, resumeFocusSession,
  softDeleteTask, startFocusSession, updateTask,
} from './store';
import type { Task } from './types';

beforeEach(async () => {
  await db.open();
  await Promise.all([db.tasks.clear(), db.sessions.clear(), db.memos.clear(), db.history.clear(), db.outbox.clear(), db.settings.clear()]);
  await ensureDefaults();
});

describe('record safe mutations', () => {
  it('updates one task without replacing another task', async () => {
    const first = await createTask({ title: 'Macで追加したタスク' });
    const second = await createTask({ title: 'iPhoneで追加する予定のタスク' });
    await updateTask(first.id, { title: '変更後' });

    expect((await db.tasks.get(first.id))?.title).toBe('変更後');
    expect((await db.tasks.get(second.id))?.title).toBe('iPhoneで追加する予定のタスク');
    expect(await db.tasks.count()).toBe(2);
    expect(await db.outbox.count()).toBe(2);
  });

  it('keeps the scheduled date when completing a task later', async () => {
    const task = await createTask({ title: '過去の予定', scheduledDate: '2026-07-10', startMinute: 600 });
    await completeTask(task.id, true);

    const completed = await db.tasks.get(task.id);
    expect(completed?.scheduledDate).toBe('2026-07-10');
    expect(completed?.startMinute).toBe(600);
    expect(completed?.status).toBe('done');
    expect(completed?.completedAt).toBeTruthy();
  });

  it('keeps a changed date on a completed task and queues that exact record', async () => {
    const task = await createTask({ title: '完了後に日付を直す', scheduledDate: '2026-07-28' });
    await completeTask(task.id, true);
    await updateTask(task.id, { scheduledDate: '2026-07-24' }, 'タスク詳細を更新');

    const changed = await db.tasks.get(task.id);
    const pending = await db.outbox.where('[entityType+entityId]').equals(['task', task.id]).first();
    expect(changed?.scheduledDate).toBe('2026-07-24');
    expect(changed?.status).toBe('done');
    expect((pending?.payload as Task | undefined)?.scheduledDate).toBe('2026-07-24');
  });

  it('soft deletes and restores without losing the task', async () => {
    const task = await createTask({ title: '消しても戻せる' });
    await softDeleteTask(task.id);
    expect((await db.tasks.get(task.id))?.deletedAt).toBeTruthy();
    expect(await db.tasks.count()).toBe(1);

    await restoreTask(task.id);
    expect((await db.tasks.get(task.id))?.deletedAt).toBeNull();
    expect((await db.tasks.get(task.id))?.title).toBe('消しても戻せる');
  });

  it('stores timer sessions independently from task schedule', async () => {
    const task = await createTask({ title: '音声タイマー', scheduledDate: '2026-07-21', estimateMin: 15 });
    const session = await startFocusSession(task, 15);

    expect(session.plannedMin).toBe(15);
    expect((await db.tasks.get(task.id))?.scheduledDate).toBe('2026-07-21');
    expect((await db.sessions.get(session.id))?.status).toBe('running');
  });

  it('keeps an interrupted timer available for resume', async () => {
    const task = await createTask({ title: '中断して戻るタイマー', estimateMin: 25 });
    const session = await startFocusSession(task, 25);

    await pauseFocusSession(session.id, '作業を中断');
    expect((await db.sessions.get(session.id))?.status).toBe('paused');
    expect((await db.sessions.get(session.id))?.endedAt).toBeNull();

    await resumeFocusSession(session.id);
    expect((await db.sessions.get(session.id))?.status).toBe('running');
    expect((await db.tasks.get(task.id))?.status).toBe('active');
  });
});
