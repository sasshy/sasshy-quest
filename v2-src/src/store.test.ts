import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import {
  completeTask, createManualFocusSession, createTask, pauseFocusSession, restoreTask, resumeFocusSession,
  redoLatestTaskChange, softDeleteTask, startFocusSession, undoLatestTaskChange, updateSession, updateTask,
} from './store';
import { taskWorkedSeconds } from './insights';
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

  it('undoes and redoes the latest task change without deleting the record', async () => {
    const task = await createTask({ title: '変更前' });
    await updateTask(task.id, { title: '変更後' }, 'タイトルを変更');

    await undoLatestTaskChange();
    expect((await db.tasks.get(task.id))?.title).toBe('変更前');

    await redoLatestTaskChange();
    expect((await db.tasks.get(task.id))?.title).toBe('変更後');
  });

  it('uses reliable past sessions as the default estimate for repeated work', async () => {
    const first = await createTask({ title: '出荷準備：前回A', estimateMin: 25 });
    const firstSession = await startFocusSession(first, 25);
    await updateSession(firstSession.id, {
      status: 'completed',
      endedAt: new Date(new Date(firstSession.startedAt).getTime() + 20 * 60_000).toISOString(),
    }, '作業を完了');

    const second = await createTask({ title: '出荷準備：今回B' });
    expect(second.estimateMin).toBe(20);
  });

  it('adds a missed work interval later and queues it for sync', async () => {
    const task = await createTask({ title: '開始を押し忘れた作業', estimateMin: 30 });
    const session = await createManualFocusSession(task, '2026-07-30T01:00:00.000Z', '2026-07-30T01:18:00.000Z');

    expect(session.status).toBe('completed');
    expect(taskWorkedSeconds(task.id, [session])).toBe(18 * 60);
    expect(await db.outbox.where('[entityType+entityId]').equals(['session', session.id]).count()).toBe(1);
  });

  it('starts the same task again with its previous work carried forward', async () => {
    const first = await createTask({ title: '分割して行う業務', estimateMin: 25 });
    const other = await createTask({ title: '割り込み業務', estimateMin: 10 });
    const firstSession = await startFocusSession(first, 25);
    await updateSession(firstSession.id, { startedAt: new Date(Date.now() - 8 * 60_000).toISOString() }, 'テスト開始時刻');
    await startFocusSession(other, 10);
    const carried = taskWorkedSeconds(first.id, await db.sessions.toArray());
    const resumed = await startFocusSession(first, 25, carried);

    expect(carried).toBeGreaterThanOrEqual(7 * 60);
    expect(resumed.carriedElapsedSec).toBe(carried);
  });
});
