import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import {
  completeTask, configureWorkStartDay, createManualFocusSession, createTask, pauseFocusSession, recordExistingMainWork,
  recordScheduleResult,
  recordWorkDayStarted, recordWorkFirstContact, restoreTask, resumeFocusSession, redoLatestTaskChange, reorderTasksForDay,
  setFocusSessionPlannedMinutes, softDeleteTask, startFocusSession, undoLatestTaskChange, updateSession, updateTask,
} from './store';
import { taskWorkedSeconds } from './insights';
import type { Task, WorkStartDay } from './types';
import { localDateKey } from './work-start';

beforeEach(async () => {
  await db.open();
  await Promise.all([db.tasks.clear(), db.sessions.clear(), db.memos.clear(), db.history.clear(), db.outbox.clear(), db.scheduleHistory.clear(), db.scheduleOutbox.clear(), db.settings.clear()]);
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

  it('creates scheduled tasks with their start notification off by default', async () => {
    const defaultOff = await createTask({
      title: '通知は不要',
      scheduledDate: '2026-09-08',
      startMinute: 600,
    });
    const explicitOn = await createTask({
      title: '服薬',
      scheduledDate: '2026-09-08',
      startMinute: 660,
      scheduledStartNotification: true,
    });

    expect(defaultOff.scheduledStartNotification).toBe(false);
    expect(explicitOn.scheduledStartNotification).toBe(true);
    expect((await db.scheduleOutbox.where('taskId').equals(defaultOff.id).first())?.taskPayload)
      .toMatchObject({ scheduledStartNotification: false });
  });

  it('reorders a day and swaps the times of adjacent timed tasks', async () => {
    const first = await createTask({ title: '最初', scheduledDate: '2026-08-05', startMinute: 600 });
    const second = await createTask({ title: '次', scheduledDate: '2026-08-05', startMinute: 660 });
    const third = await createTask({ title: '最後', scheduledDate: '2026-08-05', startMinute: 720 });

    await reorderTasksForDay([first.id, second.id, third.id], second.id, -1);

    expect((await db.tasks.get(second.id))?.flowOrder).toBe(0);
    expect((await db.tasks.get(second.id))?.startMinute).toBe(600);
    expect((await db.tasks.get(first.id))?.flowOrder).toBe(1);
    expect((await db.tasks.get(first.id))?.startMinute).toBe(660);
    expect((await db.tasks.get(third.id))?.flowOrder).toBe(2);
    expect((await db.tasks.get(third.id))?.startMinute).toBe(720);
    const changes = (await db.scheduleHistory.toArray()).filter((entry) =>
      entry.operation === 'adjust_time'
    );
    expect(changes).toHaveLength(2);
    expect(new Set(changes.map((entry) => entry.operationGroupId)).size).toBe(1);

    await undoLatestTaskChange();
    expect((await db.tasks.get(first.id))?.startMinute).toBe(600);
    expect((await db.tasks.get(second.id))?.startMinute).toBe(660);
    const reverts = (await db.scheduleHistory.toArray()).filter((entry) => entry.operation === 'revert');
    expect(reverts).toHaveLength(2);
    expect(new Set(reverts.map((entry) => entry.operationGroupId)).size).toBe(1);
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
    const pending = (await db.scheduleOutbox.where('taskId').equals(task.id).toArray()).at(-1);
    expect(changed?.scheduledDate).toBe('2026-07-24');
    expect(changed?.status).toBe('done');
    expect(pending?.taskPayload.scheduledDate).toBe('2026-07-24');
  });

  it('appends schedule versions without replacing the former placement', async () => {
    const task = await createTask({ title: '面談', scheduledDate: '2026-09-08', startMinute: 600 });
    const firstVersion = task.scheduleVersionId;
    const moved = await updateTask(task.id, { scheduledDate: '2026-09-10' }, '日付変更');
    const entries = await db.scheduleHistory.where('taskId').equals(task.id).sortBy('occurredAt');
    const queued = await db.scheduleOutbox.where('taskId').equals(task.id).toArray();

    expect(entries.map((entry) => entry.operation)).toEqual(['schedule', 'adjust_date']);
    expect(entries[0].after).toMatchObject({ scheduledDate: '2026-09-08', scheduleVersionId: firstVersion });
    expect(entries[1].before).toMatchObject({ scheduledDate: '2026-09-08', scheduleVersionId: firstVersion });
    expect(entries[1].after?.scheduledDate).toBe('2026-09-10');
    expect(moved?.scheduleVersionId).not.toBe(firstVersion);
    expect(queued).toHaveLength(2);
    expect(await db.outbox.where('[entityType+entityId]').equals(['task', task.id]).count()).toBe(0);
  });

  it('does not add a schedule event for a same-position update', async () => {
    const task = await createTask({ title: '固定', scheduledDate: '2026-09-08', startMinute: 600, durationMin: 25 });
    await updateTask(task.id, { scheduledDate: '2026-09-08', startMinute: 600, durationMin: 25 }, '同じ位置');
    expect(await db.scheduleHistory.where('taskId').equals(task.id).count()).toBe(1);
    expect(await db.scheduleOutbox.where('taskId').equals(task.id).count()).toBe(1);
  });

  it('records duration-only changes independently', async () => {
    const task = await createTask({ title: '長さだけ変更', scheduledDate: '2026-09-08', startMinute: 600, durationMin: 25 });
    await updateTask(task.id, { durationMin: 45, estimateMin: 45 }, '時間変更');
    const entries = await db.scheduleHistory.where('taskId').equals(task.id).sortBy('occurredAt');
    expect(entries.at(-1)?.operation).toBe('adjust_duration');
    expect(entries.at(-1)?.before?.durationMin).toBe(25);
    expect(entries.at(-1)?.after?.durationMin).toBe(45);
  });

  it('records a past placement result without changing the current placement', async () => {
    const task = await createTask({ title: '再予定する', scheduledDate: '2026-09-08', startMinute: 600 });
    const pastVersion = task.scheduleVersionId;
    const moved = await updateTask(task.id, { scheduledDate: '2026-09-10' }, '再予定');
    await recordScheduleResult(task.id, pastVersion || null, 'not_done', '当日は実行せず');

    const current = await db.tasks.get(task.id);
    const result = (await db.scheduleHistory.where('taskId').equals(task.id).sortBy('occurredAt')).at(-1);
    expect(current?.scheduledDate).toBe('2026-09-10');
    expect(current?.scheduleVersionId).toBe(moved?.scheduleVersionId);
    expect(result).toMatchObject({ operation: 'set_result', result: 'not_done', targetVersionId: pastVersion });
    expect((await db.scheduleOutbox.where('taskId').equals(task.id).toArray()).at(-1)?.updateTask).toBe(false);
  });

  it('closes only the current placement when explicitly marked not done', async () => {
    const task = await createTask({ title: '未実行', scheduledDate: '2026-09-08', startMinute: 600 });
    await recordScheduleResult(task.id, task.scheduleVersionId || null, 'not_done');
    const current = await db.tasks.get(task.id);
    expect(current).toMatchObject({ scheduledDate: null, startMinute: null, scheduleVersionId: null, status: 'inbox' });
    expect((await db.scheduleHistory.where('taskId').equals(task.id).sortBy('occurredAt')).at(-1)?.result).toBe('not_done');
  });

  it('does not close a placement while its timer is active', async () => {
    const task = await createTask({ title: '実行中', scheduledDate: '2026-09-08', startMinute: 600 });
    await startFocusSession(task, 25);
    await expect(recordScheduleResult(task.id, task.scheduleVersionId || null, 'skipped'))
      .rejects.toThrow('実行中のタイマー');
    expect((await db.tasks.get(task.id))?.scheduledDate).toBe('2026-09-08');
  });

  it('keeps result history append-only across undo and redo', async () => {
    const task = await createTask({ title: '完了結果', scheduledDate: '2026-09-08', startMinute: 600 });
    await completeTask(task.id, true);
    await undoLatestTaskChange();
    await redoLatestTaskChange();
    const entries = await db.scheduleHistory.where('taskId').equals(task.id).sortBy('occurredAt');
    expect(entries.slice(-3).map((entry) => entry.operation)).toEqual(['set_result', 'revert', 'reapply']);
    expect((await db.tasks.get(task.id))?.status).toBe('done');
  });

  it('records undoing a scheduled completion as an unconfirmed correction', async () => {
    const task = await createTask({ title: '完了解除', scheduledDate: '2026-09-08', startMinute: 600 });
    await completeTask(task.id, true);
    await completeTask(task.id, false);

    const current = await db.tasks.get(task.id);
    const entries = await db.scheduleHistory.where('taskId').equals(task.id).sortBy('occurredAt');
    expect(current).toMatchObject({ status: 'planned', completedAt: null, scheduledDate: '2026-09-08' });
    expect(entries.at(-1)).toMatchObject({ operation: 'correct_result', result: 'unconfirmed' });
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

  it('changes a running timer without restarting its session', async () => {
    const task = await createTask({ title: '時間を直す', estimateMin: 25 });
    const session = await startFocusSession(task, 25);
    await setFocusSessionPlannedMinutes(session.id, 12);

    const changed = await db.sessions.get(session.id);
    expect(changed?.plannedMin).toBe(12);
    expect(changed?.startedAt).toBe(session.startedAt);
    expect(changed?.status).toBe('running');
  });

  it('uses a short routine hint as the initial estimate', async () => {
    const brushing = await createTask({ title: '歯磨き' });
    const dryer = await createTask({ title: 'ドライヤー' });
    expect(brushing.estimateMin).toBe(5);
    expect(dryer.estimateMin).toBe(10);
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

  it('records an Anchor contact without starting a timer or main work', async () => {
    const task = await createTask({ title: '出荷' });
    const dateKey = localDateKey();
    await configureWorkStartDay(task.id, dateKey, workStartDay());
    await recordWorkDayStarted(task.id, dateKey, '2026-09-07T00:00:00.000Z');
    await recordWorkFirstContact(task.id, dateKey, '2026-09-07T00:05:00.000Z');

    const stored = await db.tasks.get(task.id);
    expect(stored?.workStartSupport?.days[dateKey].firstContactAt).toBe('2026-09-07T00:05:00.000Z');
    expect(stored?.workStartSupport?.days[dateKey].mainStartReportedAt).toBeNull();
    expect(await db.sessions.count()).toBe(0);
    const pending = await db.outbox.where('[entityType+entityId]').equals(['task', task.id]).first();
    expect((pending?.payload as Task).workStartSupport?.days[dateKey].firstContactAt)
      .toBe('2026-09-07T00:05:00.000Z');
  });

  it('keeps only one enabled support target for a work day', async () => {
    const first = await createTask({ title: '出荷A' });
    const second = await createTask({ title: '出荷B' });
    const dateKey = localDateKey();
    await configureWorkStartDay(first.id, dateKey, workStartDay());
    await configureWorkStartDay(second.id, dateKey, workStartDay({ anchorText: '書類を開く' }));

    expect((await db.tasks.get(first.id))?.workStartSupport?.days[dateKey].enabled).toBe(false);
    expect((await db.tasks.get(second.id))?.workStartSupport?.days[dateKey].enabled).toBe(true);
  });

  it('does not silently change the support target after activity was recorded', async () => {
    const first = await createTask({ title: '出荷A' });
    const second = await createTask({ title: '出荷B' });
    const dateKey = localDateKey();
    await configureWorkStartDay(first.id, dateKey, workStartDay());
    await recordWorkDayStarted(first.id, dateKey);

    await expect(configureWorkStartDay(second.id, dateKey, workStartDay()))
      .rejects.toThrow('開始記録後は別の対象へ変更できません');
    expect((await db.tasks.get(first.id))?.workStartSupport?.days[dateKey].enabled).toBe(true);
  });

  it('records direct main work and creates one existing focus session atomically', async () => {
    const task = await createTask({ title: '出荷' });
    const dateKey = localDateKey();
    await configureWorkStartDay(task.id, dateKey, workStartDay());
    const current = await db.tasks.get(task.id);
    const session = await startFocusSession(current!, 25);

    const stored = await db.tasks.get(task.id);
    const support = stored?.workStartSupport?.days[dateKey];
    expect(support?.firstContactAt).toBe(session.startedAt);
    expect(support?.mainStartedAt).toBe(session.startedAt);
    expect(support?.mainSessionId).toBe(session.id);
    expect(await db.sessions.count()).toBe(1);
  });

  it('does not duplicate a focus session when start is pressed twice', async () => {
    const task = await createTask({ title: '出荷' });
    const [first, second] = await Promise.all([
      startFocusSession(task, 25),
      startFocusSession(task, 25),
    ]);

    expect(second.id).toBe(first.id);
    expect(await db.sessions.where('taskId').equals(task.id).count()).toBe(1);
  });

  it('keeps the first main-work observation when a session is resumed', async () => {
    const task = await createTask({ title: '出荷' });
    const dateKey = localDateKey();
    await configureWorkStartDay(task.id, dateKey, workStartDay());
    await recordExistingMainWork(task.id, dateKey, '2026-09-07T01:00:00.000Z');
    await recordExistingMainWork(task.id, dateKey, '2026-09-07T02:00:00.000Z');

    expect((await db.tasks.get(task.id))?.workStartSupport?.days[dateKey].mainStartedAt)
      .toBe('2026-09-07T01:00:00.000Z');
  });

  it('preserves a previous work day when configuring a new one', async () => {
    const task = await createTask({ title: '出荷' });
    await configureWorkStartDay(task.id, '2026-09-06', workStartDay({}, '2026-09-06'));
    await configureWorkStartDay(task.id, '2026-09-07', workStartDay({ anchorText: '書類を開く' }, '2026-09-07'));

    const days = (await db.tasks.get(task.id))?.workStartSupport?.days;
    expect(days?.['2026-09-06'].anchorText).toBe('商品を机に出す');
    expect(days?.['2026-09-07'].anchorText).toBe('書類を開く');
  });
});

function workStartDay(overrides: Partial<WorkStartDay> = {}, dateKey = localDateKey()): WorkStartDay {
  const currentTargetAt = new Date(`${dateKey}T13:00:00`).toISOString();
  const deadlineAt = new Date(`${dateKey}T17:00:00`).toISOString();
  const latestSafeStartAt = new Date(`${dateKey}T15:00:00`).toISOString();
  return {
    enabled: true,
    anchorText: '商品を机に出す',
    currentTargetAt,
    reviewOn: '2026-09-14',
    deadlineAt,
    remainingEstimateMin: 60,
    bufferMin: 60,
    latestSafeStartAt,
    workStartedAt: null,
    firstContactAt: null,
    mainStartedAt: null,
    mainStartReportedAt: null,
    mainSessionId: null,
    morningMilestone: '午前分の梱包を終える',
    morningProgress: 'unrecorded',
    progressRecordedAt: null,
    snoozedUntil: null,
    skippedAt: null,
    notificationEndpointHash: '',
    ...overrides,
  };
}
