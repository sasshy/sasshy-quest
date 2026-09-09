import Dexie from 'dexie';
import { db, getDeviceId, makeId, nowIso } from './db';
import { predictDuration, routineEstimateHint } from './insights';
import { classifyScheduleOperation, latestResultsByVersion, scheduleSnapshot } from './schedule-history';
import type {
  FocusSession, HistoryEntry, Memo, MorningProgress, OutboxItem, ScheduleHistoryEntry, ScheduleOperation, ScheduleOutboxItem,
  ScheduleResult, Task, TaskHorizon, TaskUndoAction, UndoRedoSetting, WorkStartDay,
} from './types';
import { localDateKey, snoozeTime, validateWorkStartDay } from './work-start';

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sasshy-v2-state') : null;
const MAX_UNDO_ACTIONS = 30;
let lastScheduleEventMs = 0;

function nextScheduleEventIso(after?: string): string {
  const afterMs = after ? Date.parse(after) : 0;
  const value = Math.max(
    Date.now(),
    lastScheduleEventMs + 1,
    Number.isFinite(afterMs) ? afterMs + 1 : 0,
  );
  lastScheduleEventMs = value;
  return new Date(value).toISOString();
}

export function announceChange(): void {
  channel?.postMessage({ type: 'changed', at: Date.now() });
  window.dispatchEvent(new CustomEvent('sasshy-v2-changed'));
}

export function subscribeChanges(callback: () => void): () => void {
  const local = () => callback();
  const broadcast = () => callback();
  window.addEventListener('sasshy-v2-changed', local);
  channel?.addEventListener('message', broadcast);
  return () => {
    window.removeEventListener('sasshy-v2-changed', local);
    channel?.removeEventListener('message', broadcast);
  };
}

async function queueRecord(entityType: 'task' | 'session' | 'memo', payload: Task | FocusSession | Memo): Promise<void> {
  await db.outbox.where('[entityType+entityId]').equals([entityType, payload.id]).delete();
  const item: OutboxItem = {
    entityType,
    entityId: payload.id,
    payload,
    deleted: Boolean(payload.deletedAt),
    createdAt: nowIso(),
    attempts: 0,
  };
  await db.outbox.add(item);
}

function history(entityType: HistoryEntry['entityType'], entityId: string, action: string, label: string, before: unknown, after: unknown, source: HistoryEntry['source'] = 'local'): HistoryEntry {
  return { id: makeId('history'), entityType, entityId, action, label, before, after, createdAt: nowIso(), source };
}

interface ScheduleTransitionOptions {
  operation?: ScheduleOperation;
  operationGroupId?: string | null;
  relatedEntryId?: string | null;
  result?: ScheduleResult;
  reason?: string;
  source?: ScheduleHistoryEntry['source'];
  preserveVersion?: boolean;
}

function normalizeScheduleVersion(task: Task): Task {
  if (!task.scheduledDate || task.scheduleVersionId) return task;
  return { ...task, scheduleVersionId: makeId('schedule-version') };
}

async function queueScheduleEntry(
  before: Task,
  after: Task,
  entry: ScheduleHistoryEntry,
  updateTask = true,
): Promise<void> {
  await db.outbox.where('[entityType+entityId]').equals(['task', after.id]).delete();
  const item: ScheduleOutboxItem = {
    operationId: entry.id,
    taskId: after.id,
    baseRevision: before.sync.serverUpdatedAt || null,
    taskPayload: after,
    updateTask,
    history: entry,
    createdAt: entry.occurredAt,
    attempts: 0,
  };
  await db.scheduleOutbox.add(item);
}

async function queueTaskOrRefreshSchedule(payload: Task): Promise<void> {
  const pending = await db.scheduleOutbox.where('taskId').equals(payload.id).last();
  if (pending?.id !== undefined) {
    await db.scheduleOutbox.update(pending.id, { taskPayload: payload });
    await db.outbox.where('[entityType+entityId]').equals(['task', payload.id]).delete();
    return;
  }
  await queueRecord('task', payload);
}

async function recordScheduleTransition(
  beforeInput: Task,
  nextInput: Task,
  options: ScheduleTransitionOptions = {},
): Promise<{ before: Task; after: Task; entry: ScheduleHistoryEntry } | null> {
  const operation = options.operation || classifyScheduleOperation(beforeInput, nextInput);
  if (!operation) return null;
  const before = normalizeScheduleVersion(beforeInput);
  const after: Task = {
    ...nextInput,
    scheduleVersionId: nextInput.scheduledDate
      ? options.preserveVersion
        ? before.scheduleVersionId
        : makeId('schedule-version')
      : null,
  };
  const occurredAt = nextScheduleEventIso(beforeInput.updatedAt);
  const entry: ScheduleHistoryEntry = {
    id: makeId('schedule-operation'),
    taskId: after.id,
    operationGroupId: options.operationGroupId || null,
    beforeVersionId: before.scheduleVersionId || null,
    afterVersionId: after.scheduleVersionId || null,
    targetVersionId: options.result ? before.scheduleVersionId || after.scheduleVersionId || null : null,
    operation,
    result: options.result || 'unconfirmed',
    before: scheduleSnapshot(before),
    after: scheduleSnapshot(after),
    title: after.title,
    occurredAt,
    serverReceivedAt: null,
    deviceId: after.sync.deviceId,
    source: options.source || 'local',
    relatedEntryId: options.relatedEntryId || null,
    reason: options.reason?.trim() || '',
  };
  await db.scheduleHistory.add(entry);
  await queueScheduleEntry(before, after, entry);
  return { before, after, entry };
}

async function recordInitialSchedule(task: Task): Promise<ScheduleHistoryEntry> {
  const entry: ScheduleHistoryEntry = {
    id: makeId('schedule-operation'),
    taskId: task.id,
    operationGroupId: null,
    beforeVersionId: null,
    afterVersionId: task.scheduleVersionId || null,
    targetVersionId: null,
    operation: 'schedule',
    result: 'unconfirmed',
    before: null,
    after: scheduleSnapshot(task),
    title: task.title,
    occurredAt: nextScheduleEventIso(task.createdAt),
    serverReceivedAt: null,
    deviceId: task.sync.deviceId,
    source: 'local',
    relatedEntryId: null,
    reason: '',
  };
  await db.scheduleHistory.add(entry);
  await queueScheduleEntry(task, task, entry);
  return entry;
}

export async function getUndoRedoState(): Promise<UndoRedoSetting> {
  const stored = await db.settings.get('undo-redo') as unknown as UndoRedoSetting | undefined;
  return stored || { id: 'undo-redo', undo: [], redo: [] };
}

async function recordUndoAction(
  before: Task | null,
  after: Task | null,
  label: string,
  scheduleOperationIds: string[] = [],
): Promise<void> {
  const state = await getUndoRedoState();
  const action: TaskUndoAction = {
    id: makeId('undo'),
    label,
    before,
    after,
    expectedUpdatedAt: after?.updatedAt || null,
    createdAt: nowIso(),
    scheduleOperationIds,
  };
  await db.settings.put({
    id: 'undo-redo',
    undo: [...state.undo, action].slice(-MAX_UNDO_ACTIONS),
    redo: [],
  });
}

async function recordUndoGroup(
  beforeGroup: Task[],
  afterGroup: Task[],
  label: string,
  scheduleOperationIds: string[],
): Promise<void> {
  const state = await getUndoRedoState();
  const action: TaskUndoAction = {
    id: makeId('undo'),
    label,
    before: null,
    after: null,
    expectedUpdatedAt: null,
    createdAt: nowIso(),
    beforeGroup,
    afterGroup,
    scheduleOperationIds,
    expectedUpdatedAts: Object.fromEntries(afterGroup.map((task) => [task.id, task.updatedAt])),
  };
  await db.settings.put({
    id: 'undo-redo',
    undo: [...state.undo, action].slice(-MAX_UNDO_ACTIONS),
    redo: [],
  });
}

export interface NewTaskInput {
  title: string;
  notes?: string;
  horizon?: TaskHorizon;
  scheduledDate?: string | null;
  startMinute?: number | null;
  scheduledStartNotification?: boolean;
  durationMin?: number;
  estimateMin?: number;
  importance?: 0 | 1 | 2;
  urgency?: 0 | 1 | 2;
  source?: 'v2' | 'legacy';
  legacyId?: string;
}

export async function createTask(input: NewTaskInput, source: HistoryEntry['source'] = 'local'): Promise<Task> {
  const createdAt = nowIso();
  const deviceId = await getDeviceId();
  const scheduledDate = input.scheduledDate || null;
  const requestedEstimate = input.estimateMin ?? input.durationMin;
  const prediction = requestedEstimate === undefined
    ? predictDuration(input.title, await db.sessions.toArray())
    : null;
  const estimateMin = Math.max(5, requestedEstimate ?? prediction?.predictedMin ?? routineEstimateHint(input.title) ?? 25);
  const task: Task = {
    id: makeId('task'),
    title: input.title.trim(),
    notes: input.notes?.trim() || '',
    status: scheduledDate ? 'planned' : 'inbox',
    horizon: input.horizon || 'now',
    scheduledDate,
    startMinute: input.startMinute ?? null,
    scheduleVersionId: scheduledDate ? makeId('schedule-version') : null,
    scheduledStartNotification: input.scheduledStartNotification ?? false,
    durationMin: Math.max(5, input.durationMin ?? estimateMin),
    estimateMin,
    importance: input.importance || 0,
    urgency: input.urgency || 0,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    deletedAt: null,
    source: input.source || 'v2',
    legacyId: input.legacyId,
    sync: { deviceId },
  };
  await db.transaction('rw', [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings], async () => {
    await db.tasks.add(task);
    await db.history.add(history('task', task.id, 'create', `「${task.title}」を追加`, null, task, source));
    const scheduleEntry = task.scheduledDate ? await recordInitialSchedule(task) : null;
    if (!scheduleEntry) await queueRecord('task', task);
    if (source === 'local') await recordUndoAction(null, task, `「${task.title}」を追加`, scheduleEntry ? [scheduleEntry.id] : []);
  });
  announceChange();
  return task;
}

export async function updateTask(
  id: string,
  changes: Partial<Omit<Task, 'id' | 'createdAt' | 'sync'>>,
  label = 'タスクを更新',
  trackUndo = true,
): Promise<Task | null> {
  const deviceId = await getDeviceId();
  let result: Task | null = null;
  await db.transaction('rw', [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings], async () => {
    const before = await db.tasks.get(id);
    if (!before) return;
    const scheduledDate = changes.scheduledDate === undefined ? before.scheduledDate : changes.scheduledDate;
    let next: Task = {
      ...before,
      ...changes,
      status: changes.status || (before.status === 'done' || before.status === 'archived' ? before.status : scheduledDate ? 'planned' : 'inbox'),
      scheduledDate,
      updatedAt: nowIso(),
      sync: { ...before.sync, deviceId },
    };
    const scheduleChange = await recordScheduleTransition(before, next);
    const undoBefore = scheduleChange?.before || before;
    if (scheduleChange) next = scheduleChange.after;
    await db.tasks.put(next);
    await db.history.add(history('task', id, 'update', label, undoBefore, next));
    if (!scheduleChange) await queueTaskOrRefreshSchedule(next);
    if (trackUndo) await recordUndoAction(undoBefore, next, label, scheduleChange ? [scheduleChange.entry.id] : []);
    result = next;
  });
  announceChange();
  return result;
}

export async function recordScheduleResult(
  taskId: string,
  requestedVersionId: string | null,
  result: ScheduleResult,
  reason = '',
  moveSkippedToSomeday = false,
): Promise<Task> {
  const deviceId = await getDeviceId();
  let saved: Task | null = null;
  await db.transaction(
    'rw',
    [db.tasks, db.sessions, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings],
    async () => {
      const stored = await db.tasks.get(taskId);
      if (!stored) throw new Error('対象タスクが見つかりません');
      let current = normalizeScheduleVersion(stored);
      const entries = await db.scheduleHistory.where('taskId').equals(taskId).toArray();
      const targetVersionId = requestedVersionId || current.scheduleVersionId || null;
      const targetSnapshot = targetVersionId === current.scheduleVersionId
        ? scheduleSnapshot(current)
        : entries.flatMap((entry) => [entry.before, entry.after])
          .find((snapshot) => snapshot?.scheduleVersionId === targetVersionId) || null;
      if (!targetVersionId || !targetSnapshot) throw new Error('対象の予定版が見つかりません');
      const previousResult = latestResultsByVersion(entries).get(targetVersionId);
      if (result === 'unconfirmed' && (!previousResult || previousResult === 'unconfirmed')) {
        throw new Error('結果を選んでください');
      }
      const isCurrent = targetVersionId === current.scheduleVersionId;
      const closesCurrent = isCurrent && ['not_done', 'cancelled', 'skipped'].includes(result);
      if (closesCurrent) {
        const active = await db.sessions.where('taskId').equals(taskId).filter((session) =>
          !session.deletedAt && (session.status === 'running' || session.status === 'paused')
        ).first();
        if (active) throw new Error('実行中のタイマーを先に完了または中断してください');
      }

      const before = current;
      const at = nowIso();
      const occurredAt = nextScheduleEventIso(at);
      let next = current;
      if (isCurrent && result === 'completed') {
        next = { ...current, status: 'done', completedAt: current.completedAt || at };
      } else if (isCurrent && result === 'unconfirmed' && current.status === 'done') {
        next = { ...current, status: 'planned', completedAt: null };
      } else if (closesCurrent) {
        let workStartSupport = current.workStartSupport;
        if ((result === 'cancelled' || result === 'skipped') && targetSnapshot.scheduledDate && workStartSupport?.version === 1) {
          const supportDay = workStartSupport.days[targetSnapshot.scheduledDate];
          if (supportDay?.enabled) {
            workStartSupport = {
              ...workStartSupport,
              days: {
                ...workStartSupport.days,
                [targetSnapshot.scheduledDate]: { ...supportDay, enabled: false },
              },
            };
          }
        }
        next = {
          ...current,
          scheduledDate: null,
          startMinute: null,
          scheduleVersionId: null,
          status: 'inbox',
          horizon: result === 'skipped' && moveSkippedToSomeday ? 'someday' : current.horizon,
          workStartSupport,
        };
      }
      const taskChanged = next !== current || stored !== current;
      if (taskChanged) {
        next = { ...next, updatedAt: at, sync: { ...next.sync, deviceId } };
        await db.tasks.put(next);
      }

      const entry: ScheduleHistoryEntry = {
        id: makeId('schedule-operation'),
        taskId,
        operationGroupId: null,
        beforeVersionId: before.scheduleVersionId || null,
        afterVersionId: next.scheduleVersionId || null,
        targetVersionId,
        operation: previousResult && previousResult !== 'unconfirmed' ? 'correct_result' : 'set_result',
        result,
        before: targetSnapshot,
        after: isCurrent ? scheduleSnapshot(next) : targetSnapshot,
        title: targetSnapshot.title || current.title,
        occurredAt,
        serverReceivedAt: null,
        deviceId,
        source: 'local',
        relatedEntryId: entries
          .filter((entry) => entry.targetVersionId === targetVersionId && ['set_result', 'correct_result'].includes(entry.operation))
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]?.id || null,
        reason: reason.trim(),
      };
      await db.scheduleHistory.add(entry);
      await queueScheduleEntry(before, next, entry, taskChanged);
      await db.history.add(history('task', taskId, entry.operation, `${current.title}の予定結果を記録`, before, next));
      if (taskChanged) await recordUndoAction(before, next, `${current.title}の予定結果を記録`, [entry.id]);
      saved = next;
    },
  );
  announceChange();
  if (!saved) throw new Error('予定結果を保存できませんでした');
  return saved;
}

export async function reorderTasksForDay(
  orderedTaskIds: string[],
  movedTaskId: string,
  direction: -1 | 1,
): Promise<void> {
  const currentIndex = orderedTaskIds.indexOf(movedTaskId);
  const targetIndex = currentIndex + direction;
  if (
    currentIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= orderedTaskIds.length
  ) return;

  const nextIds = [...orderedTaskIds];
  [nextIds[currentIndex], nextIds[targetIndex]] = [
    nextIds[targetIndex],
    nextIds[currentIndex],
  ];
  const records = await db.tasks.bulkGet(nextIds);
  const byId = new Map(
    records.filter((task): task is Task => Boolean(task)).map((task) => [task.id, task]),
  );
  const moved = byId.get(movedTaskId);
  const target = byId.get(orderedTaskIds[targetIndex]);
  const swapTimes =
    moved?.startMinute !== null &&
    moved?.startMinute !== undefined &&
    target?.startMinute !== null &&
    target?.startMinute !== undefined;

  const beforeGroup: Task[] = [];
  const deviceId = await getDeviceId();
  const at = nowIso();
  const operationGroupId = makeId('schedule-group');
  const afterGroup: Task[] = [];
  const scheduleOperationIds: string[] = [];
  await db.transaction(
    'rw',
    [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings],
    async () => {
      for (const [flowOrder, taskId] of nextIds.entries()) {
        const before = byId.get(taskId);
        if (!before) continue;
        let startMinute = before.startMinute;
        if (swapTimes && before.id === moved?.id) startMinute = target!.startMinute;
        if (swapTimes && before.id === target?.id) startMinute = moved!.startMinute;
        let next: Task = {
          ...before,
          flowOrder,
          startMinute,
          updatedAt: at,
          sync: { ...before.sync, deviceId },
        };
        const scheduleChange = await recordScheduleTransition(before, next, { operationGroupId });
        const historyBefore = scheduleChange?.before || before;
        beforeGroup.push(historyBefore);
        if (scheduleChange) {
          next = scheduleChange.after;
          scheduleOperationIds.push(scheduleChange.entry.id);
        } else {
          await queueTaskOrRefreshSchedule(next);
        }
        await db.tasks.put(next);
        await db.history.add(history('task', before.id, 'update', '今日の順番を変更', historyBefore, next));
        afterGroup.push(next);
      }
      await recordUndoGroup(beforeGroup, afterGroup, '今日の順番を変更', scheduleOperationIds);
    },
  );
  announceChange();
}

export async function completeTask(id: string, done: boolean): Promise<Task | null> {
  const task = await db.tasks.get(id);
  if (task?.scheduledDate) {
    if (done) return recordScheduleResult(id, task.scheduleVersionId || null, 'completed');
    if (task.scheduleVersionId) {
      const entries = await db.scheduleHistory.where('taskId').equals(id).toArray();
      if (latestResultsByVersion(entries).get(task.scheduleVersionId) === 'completed') {
        return recordScheduleResult(id, task.scheduleVersionId, 'unconfirmed');
      }
    }
  }
  return updateTask(id, {
    status: done ? 'done' : 'planned',
    completedAt: done ? nowIso() : null,
  }, done ? 'タスクを完了' : '完了を取り消し');
}

export async function softDeleteTask(id: string): Promise<Task | null> {
  return updateTask(id, { deletedAt: nowIso(), status: 'archived' }, 'タスクをゴミ箱へ移動');
}

export async function restoreTask(id: string): Promise<Task | null> {
  const existing = await db.tasks.get(id);
  return updateTask(id, {
    deletedAt: null,
    status: existing?.scheduledDate ? 'planned' : 'inbox',
  }, 'タスクを復元');
}

export async function restoreHistoryEntry(entry: HistoryEntry): Promise<void> {
  if (entry.entityType !== 'task' || !entry.before) return;
  const snapshot = entry.before as Task;
  const deviceId = await getDeviceId();
  const current = await db.tasks.get(snapshot.id);
  let restored: Task = { ...snapshot, updatedAt: nowIso(), sync: { ...snapshot.sync, deviceId } };
  await db.transaction('rw', [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings], async () => {
    const scheduleChange = current ? await recordScheduleTransition(current, restored) : null;
    const historyBefore = scheduleChange?.before || current || null;
    if (scheduleChange) restored = scheduleChange.after;
    await db.tasks.put(restored);
    await db.history.add(history('task', restored.id, 'restore', `「${restored.title}」を履歴から復元`, historyBefore, restored));
    if (!scheduleChange) await queueTaskOrRefreshSchedule(restored);
    await recordUndoAction(historyBefore, restored, `「${restored.title}」を履歴から復元`, scheduleChange ? [scheduleChange.entry.id] : []);
  });
  announceChange();
}

async function applyUndoSnapshot(
  action: TaskUndoAction,
  direction: 'undo' | 'redo',
): Promise<{ result: string; restored: Task[] } | null> {
  const deviceId = await getDeviceId();
  const sourceGroup = direction === 'undo'
    ? action.afterGroup || (action.after ? [action.after] : action.before ? [action.before] : [])
    : action.beforeGroup || (action.before ? [action.before] : action.after ? [action.after] : []);
  const targetGroup = direction === 'undo'
    ? action.beforeGroup || (action.before ? [action.before] : [])
    : action.afterGroup || (action.after ? [action.after] : []);
  const currentGroup = await db.tasks.bulkGet(sourceGroup.map((task) => task.id));
  if (currentGroup.some((task) => !task)) return null;
  const expected = action.expectedUpdatedAts || (action.expectedUpdatedAt && sourceGroup[0]
    ? { [sourceGroup[0].id]: action.expectedUpdatedAt }
    : {});
  if (currentGroup.some((task) => task && expected[task.id] && task.updatedAt !== expected[task.id])) return null;

  const originalEntries = (await db.scheduleHistory.bulkGet(action.scheduleOperationIds || []))
    .filter((entry): entry is ScheduleHistoryEntry => Boolean(entry));
  const targetById = new Map(targetGroup.map((task) => [task.id, task]));
  const restored: Task[] = [];
  const operationGroupId = makeId('schedule-group');
  const at = nowIso();
  for (const current of currentGroup.filter((task): task is Task => Boolean(task))) {
    const target = targetById.get(current.id);
    let next: Task = target
      ? { ...target, updatedAt: at, sync: { ...target.sync, deviceId } }
      : { ...current, status: 'archived', deletedAt: at, updatedAt: at, sync: { ...current.sync, deviceId } };
    const relatedEntryId = originalEntries.find((entry) => entry.taskId === current.id)?.id || null;
    const scheduleFieldsWillChange = Boolean(classifyScheduleOperation(current, next));
    const scheduleChange = scheduleFieldsWillChange || relatedEntryId
      ? await recordScheduleTransition(current, next, {
          operation: direction === 'undo' ? 'revert' : 'reapply',
          operationGroupId,
          relatedEntryId,
          preserveVersion: !scheduleFieldsWillChange,
        })
      : null;
    if (scheduleChange) next = scheduleChange.after;
    else await queueTaskOrRefreshSchedule(next);
    await db.tasks.put(next);
    await db.history.add(history(
      'task',
      next.id,
      direction,
      `${direction === 'undo' ? '元に戻す' : 'やり直す'}：${action.label}`,
      current,
      next,
    ));
    restored.push(next);
  }
  return {
    result: `${direction === 'undo' ? '元に戻しました' : 'やり直しました'}：${action.label}`,
    restored,
  };
}

export async function undoLatestTaskChange(): Promise<string | null> {
  let message: string | null = null;
  await db.transaction('rw', [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings], async () => {
    const state = await getUndoRedoState();
    const action = state.undo[state.undo.length - 1];
    if (!action) return;
    const applied = await applyUndoSnapshot(action, 'undo');
    const nextUndo = state.undo.slice(0, -1);
    if (!applied) {
      await db.settings.put({ id: 'undo-redo', undo: nextUndo, redo: [] });
      message = '他の端末で更新されたため、この操作は戻せませんでした';
      return;
    }
    await db.settings.put({
      id: 'undo-redo',
      undo: nextUndo,
      redo: [...state.redo, {
        ...action,
        expectedUpdatedAt: applied.restored[0]?.updatedAt || null,
        expectedUpdatedAts: Object.fromEntries(applied.restored.map((task) => [task.id, task.updatedAt])),
      }].slice(-MAX_UNDO_ACTIONS),
    });
    message = applied.result;
  });
  announceChange();
  return message;
}

export async function redoLatestTaskChange(): Promise<string | null> {
  let message: string | null = null;
  await db.transaction('rw', [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox, db.settings], async () => {
    const state = await getUndoRedoState();
    const action = state.redo[state.redo.length - 1];
    if (!action) return;
    const applied = await applyUndoSnapshot(action, 'redo');
    const nextRedo = state.redo.slice(0, -1);
    if (!applied) {
      await db.settings.put({ id: 'undo-redo', undo: state.undo, redo: nextRedo });
      message = '他の端末で更新されたため、この操作はやり直せませんでした';
      return;
    }
    await db.settings.put({
      id: 'undo-redo',
      undo: [...state.undo, {
        ...action,
        expectedUpdatedAt: applied.restored[0]?.updatedAt || null,
        expectedUpdatedAts: Object.fromEntries(applied.restored.map((task) => [task.id, task.updatedAt])),
      }].slice(-MAX_UNDO_ACTIONS),
      redo: nextRedo,
    });
    message = applied.result;
  });
  announceChange();
  return message;
}

function withWorkStartDay(task: Task, dateKey: string, day: WorkStartDay): Task {
  return {
    ...task,
    workStartSupport: {
      version: 1,
      days: { ...(task.workStartSupport?.days || {}), [dateKey]: day },
    },
  };
}

function currentWorkStartDay(task: Task, dateKey: string): WorkStartDay {
  const day = task.workStartSupport?.version === 1
    ? task.workStartSupport.days[dateKey]
    : undefined;
  if (!day) throw new Error('この日の開始支援が見つかりません');
  return day;
}

async function mutateWorkStartDay(
  taskId: string,
  dateKey: string,
  label: string,
  mutate: (day: WorkStartDay) => WorkStartDay,
): Promise<Task> {
  const deviceId = await getDeviceId();
  let result: Task | null = null;
  await db.transaction('rw', db.tasks, db.history, db.outbox, async () => {
    const before = await db.tasks.get(taskId);
    if (!before) throw new Error('対象タスクが見つかりません');
    const day = mutate(currentWorkStartDay(before, dateKey));
    const next = {
      ...withWorkStartDay(before, dateKey, day),
      updatedAt: nowIso(),
      sync: { ...before.sync, deviceId },
    };
    await db.tasks.put(next);
    await db.history.add(history('task', taskId, 'update', label, before, next));
    await queueRecord('task', next);
    result = next;
  });
  announceChange();
  if (!result) throw new Error('開始支援を保存できませんでした');
  return result;
}

export async function configureWorkStartDay(taskId: string, dateKey: string, day: WorkStartDay): Promise<Task> {
  const errors = validateWorkStartDay(day);
  if (errors.length) throw new Error(errors[0]);
  if (localDateKey(new Date(day.currentTargetAt)) !== dateKey) {
    throw new Error('Current Targetは対象の仕事日に設定してください');
  }
  const deviceId = await getDeviceId();
  let result: Task | null = null;
  await db.transaction('rw', db.tasks, db.history, db.outbox, async () => {
    const tasks = await db.tasks.toArray();
    const selected = tasks.find((task) => task.id === taskId);
    if (!selected) throw new Error('対象タスクが見つかりません');
    for (const task of tasks) {
      if (task.id === taskId) continue;
      const existing = task.workStartSupport?.days[dateKey];
      if (!existing?.enabled) continue;
      if (existing.workStartedAt || existing.firstContactAt || existing.mainStartReportedAt) {
        throw new Error('開始記録後は別の対象へ変更できません。記録を訂正してください');
      }
      const disabled = withWorkStartDay(task, dateKey, { ...existing, enabled: false });
      const next = { ...disabled, updatedAt: nowIso(), sync: { ...task.sync, deviceId } };
      await db.tasks.put(next);
      await db.history.add(history('task', task.id, 'update', '当日の開始支援対象を変更', task, next));
      await queueRecord('task', next);
    }
    const before = await db.tasks.get(taskId);
    if (!before) throw new Error('対象タスクが見つかりません');
    const next = {
      ...withWorkStartDay(before, dateKey, day),
      updatedAt: nowIso(),
      sync: { ...before.sync, deviceId },
    };
    await db.tasks.put(next);
    await db.history.add(history('task', taskId, 'update', '当日の開始支援を設定', before, next));
    await queueRecord('task', next);
    result = next;
  });
  announceChange();
  if (!result) throw new Error('開始支援を保存できませんでした');
  return result;
}

export function recordWorkDayStarted(taskId: string, dateKey: string, at = nowIso(), correct = false): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, correct ? '仕事開始時刻を訂正' : '仕事開始を記録', (day) => ({
    ...day,
    workStartedAt: correct ? at : day.workStartedAt || at,
  }));
}

export function recordWorkFirstContact(taskId: string, dateKey: string, at = nowIso()): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, 'Morning Anchorへ接触', (day) => ({
    ...day,
    firstContactAt: day.firstContactAt || at,
  }));
}

export function recordExistingMainWork(
  taskId: string,
  dateKey: string,
  mainStartedAt: string | null,
  mainSessionId: string | null = null,
  reportedAt = nowIso(),
): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, '本作業開始を記録', (day) => ({
    ...day,
    firstContactAt: day.firstContactAt || mainStartedAt,
    mainStartedAt: day.mainStartedAt || mainStartedAt,
    mainStartReportedAt: day.mainStartReportedAt || reportedAt,
    mainSessionId: day.mainSessionId || mainSessionId,
    snoozedUntil: null,
  }));
}

export function correctWorkStartRecords(
  taskId: string,
  dateKey: string,
  records: Pick<WorkStartDay, 'workStartedAt' | 'firstContactAt' | 'mainStartedAt'>,
): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, '開始記録を訂正', (day) => {
    const next = {
      ...day,
      ...records,
      mainStartReportedAt: records.mainStartedAt ? day.mainStartReportedAt || nowIso() : day.mainStartReportedAt,
    };
    const errors = validateWorkStartDay(next);
    if (errors.length) throw new Error(errors[0]);
    return next;
  });
}

export async function snoozeWorkStart(taskId: string, dateKey: string, now = new Date()): Promise<{ task: Task; scheduledAt: string | null }> {
  let scheduledAt: string | null = null;
  const task = await mutateWorkStartDay(taskId, dateKey, '開始支援を10分延期', (day) => {
    scheduledAt = snoozeTime(day, now);
    return { ...day, snoozedUntil: scheduledAt };
  });
  return { task, scheduledAt };
}

export function skipWorkStartDay(taskId: string, dateKey: string, at = nowIso()): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, '当日の開始支援を見送る', (day) => ({
    ...day,
    skippedAt: day.skippedAt || at,
    snoozedUntil: null,
  }));
}

export function disableWorkStartDay(taskId: string, dateKey: string): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, '当日の開始支援を無効化', (day) => ({
    ...day,
    enabled: false,
    snoozedUntil: null,
  }));
}

export function setMorningProgress(
  taskId: string,
  dateKey: string,
  morningProgress: MorningProgress,
  at = nowIso(),
): Promise<Task> {
  return mutateWorkStartDay(taskId, dateKey, '午前の進捗を記録', (day) => ({
    ...day,
    morningProgress,
    progressRecordedAt: morningProgress === 'unrecorded' ? null : at,
  }));
}

export async function startFocusSession(task: Task, plannedMin = task.estimateMin, carriedElapsedSec = 0): Promise<FocusSession> {
  const deviceId = await getDeviceId();
  const at = nowIso();
  const session: FocusSession = {
    id: makeId('session'),
    taskId: task.id,
    taskTitle: task.title,
    plannedMin: Math.max(1, plannedMin),
    carriedElapsedSec: Math.max(0, carriedElapsedSec),
    startedAt: at,
    pausedAt: null,
    pausedTotalSec: 0,
    endedAt: null,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    sync: { deviceId },
  };
  let result = session;
  await db.transaction('rw', db.sessions, db.tasks, db.history, db.outbox, async () => {
    const running = await db.sessions.where('status').anyOf('running', 'paused').toArray();
    const existing = running.find((other) => other.taskId === task.id && !other.deletedAt);
    if (existing) {
      result = existing;
      const currentTask = await db.tasks.get(task.id) || task;
      const dateKey = localDateKey(new Date(at));
      const supportDay = currentTask.workStartSupport?.days[dateKey];
      if (supportDay?.enabled && !supportDay.mainStartReportedAt && !supportDay.skippedAt) {
        const updated = {
          ...withWorkStartDay(currentTask, dateKey, {
            ...supportDay,
            firstContactAt: supportDay.firstContactAt || existing.startedAt,
            mainStartedAt: supportDay.mainStartedAt || existing.startedAt,
            mainStartReportedAt: at,
            mainSessionId: supportDay.mainSessionId || existing.id,
            snoozedUntil: null,
          }),
          updatedAt: at,
          sync: { ...currentTask.sync, deviceId },
        };
        await db.tasks.put(updated);
        await queueRecord('task', updated);
      }
      return;
    }
    for (const other of running) {
      const extraPausedSec = other.status === 'paused' && other.pausedAt
        ? Math.max(0, Math.floor((new Date(at).getTime() - new Date(other.pausedAt).getTime()) / 1000))
        : 0;
      const interrupted = {
        ...other,
        status: 'interrupted' as const,
        endedAt: at,
        pausedAt: null,
        pausedTotalSec: other.pausedTotalSec + extraPausedSec,
        updatedAt: at,
        sync: { ...other.sync, deviceId },
      };
      await db.sessions.put(interrupted);
      await queueRecord('session', interrupted);
    }
    await db.sessions.add(session);
    await queueRecord('session', session);
    await db.history.add(history('session', session.id, 'start', `「${task.title}」を開始`, null, session));
    const currentTask = await db.tasks.get(task.id) || task;
    let active = currentTask;
    const dateKey = localDateKey(new Date(at));
    const supportDay = currentTask.workStartSupport?.days[dateKey];
    if (supportDay?.enabled && !supportDay.mainStartReportedAt && !supportDay.skippedAt) {
      active = withWorkStartDay(active, dateKey, {
        ...supportDay,
        firstContactAt: supportDay.firstContactAt || at,
        mainStartedAt: supportDay.mainStartedAt || at,
        mainStartReportedAt: at,
        mainSessionId: supportDay.mainSessionId || session.id,
        snoozedUntil: null,
      });
    }
    if (currentTask.status !== 'done') {
      active = { ...active, status: 'active' as const };
    }
    if (active !== currentTask) {
      active = { ...active, updatedAt: at, sync: { ...currentTask.sync, deviceId } };
      await db.tasks.put(active);
      await queueRecord('task', active);
    }
  });
  announceChange();
  return result;
}

export async function createManualFocusSession(task: Task, startedAt: string, endedAt: string): Promise<FocusSession> {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('終了時刻は開始時刻より後にしてください');
  }
  const deviceId = await getDeviceId();
  const at = nowIso();
  const session: FocusSession = {
    id: makeId('session'),
    taskId: task.id,
    taskTitle: task.title,
    plannedMin: task.estimateMin,
    carriedElapsedSec: 0,
    startedAt: start.toISOString(),
    pausedAt: null,
    pausedTotalSec: 0,
    endedAt: end.toISOString(),
    status: 'completed',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    sync: { deviceId },
  };
  await db.transaction('rw', db.sessions, db.history, db.outbox, async () => {
    await db.sessions.add(session);
    await db.history.add(history('session', session.id, 'create', `「${task.title}」の実績を後から追加`, null, session));
    await queueRecord('session', session);
  });
  announceChange();
  return session;
}

export async function softDeleteSession(id: string): Promise<FocusSession | null> {
  return updateSession(id, { deletedAt: nowIso() }, '作業実績を削除');
}

export async function updateSession(id: string, changes: Partial<FocusSession>, label: string): Promise<FocusSession | null> {
  const deviceId = await getDeviceId();
  let result: FocusSession | null = null;
  await db.transaction('rw', db.sessions, db.history, db.outbox, async () => {
    const before = await db.sessions.get(id);
    if (!before) return;
    const next = { ...before, ...changes, id: before.id, updatedAt: nowIso(), sync: { ...before.sync, deviceId } };
    await db.sessions.put(next);
    await db.history.add(history('session', id, 'update', label, before, next));
    await queueRecord('session', next);
    result = next;
  });
  announceChange();
  return result;
}

export async function pauseFocusSession(id: string, label = 'タイマーを一時停止'): Promise<FocusSession | null> {
  const session = await db.sessions.get(id);
  if (!session || session.status !== 'running') return session || null;
  return updateSession(id, { status: 'paused', pausedAt: nowIso() }, label);
}

export async function resumeFocusSession(id: string): Promise<FocusSession | null> {
  const session = await db.sessions.get(id);
  if (!session || session.status !== 'paused') return session || null;
  const pausedSec = session.pausedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(session.pausedAt).getTime()) / 1000))
    : 0;
  return updateSession(id, {
    status: 'running',
    pausedAt: null,
    pausedTotalSec: session.pausedTotalSec + pausedSec,
  }, 'タイマーを再開');
}

export async function setFocusSessionPlannedMinutes(id: string, plannedMin: number): Promise<FocusSession | null> {
  const nextMinutes = Math.max(1, Math.min(480, Math.round(plannedMin)));
  return updateSession(id, { plannedMin: nextMinutes }, `タイマーを${nextMinutes}分に変更`);
}

export async function createMemo(input: Pick<Memo, 'title' | 'body'> & Partial<Pick<Memo, 'category' | 'pinned' | 'reminderAt' | 'source' | 'legacyId'>>, source: HistoryEntry['source'] = 'local'): Promise<Memo> {
  const at = nowIso();
  const deviceId = await getDeviceId();
  const memo: Memo = {
    id: makeId('memo'),
    title: input.title.trim(),
    body: input.body.trim(),
    category: input.category || '未整理',
    pinned: Boolean(input.pinned),
    reminderAt: input.reminderAt || null,
    archived: false,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    source: input.source || 'v2',
    legacyId: input.legacyId,
    sync: { deviceId },
  };
  await db.transaction('rw', db.memos, db.history, db.outbox, async () => {
    await db.memos.add(memo);
    await db.history.add(history('system', memo.id, 'create', `メモ「${memo.title || memo.body.slice(0, 18)}」を追加`, null, memo, source));
    await queueRecord('memo', memo);
  });
  announceChange();
  return memo;
}

export async function updateMemo(id: string, changes: Partial<Omit<Memo, 'id' | 'createdAt' | 'sync'>>, label = 'メモを更新'): Promise<Memo | null> {
  const deviceId = await getDeviceId();
  let result: Memo | null = null;
  await db.transaction('rw', db.memos, db.history, db.outbox, async () => {
    const before = await db.memos.get(id);
    if (!before) return;
    const next: Memo = { ...before, ...changes, updatedAt: nowIso(), sync: { ...before.sync, deviceId } };
    await db.memos.put(next);
    await db.history.add(history('system', id, 'update', label, before, next));
    await queueRecord('memo', next);
    result = next;
  });
  announceChange();
  return result;
}

export async function applyRemoteRecord(entityType: 'task' | 'session' | 'memo', payload: Task | FocusSession | Memo, deleted: boolean, serverUpdatedAt: string): Promise<void> {
  const table = entityType === 'task' ? db.tasks : entityType === 'session' ? db.sessions : db.memos;
  const current = await table.get(payload.id as never) as Task | FocusSession | Memo | undefined;
  if (current?.sync.serverUpdatedAt === serverUpdatedAt) return;
  const incoming = { ...payload, deletedAt: deleted ? payload.deletedAt || serverUpdatedAt : payload.deletedAt, sync: { ...payload.sync, serverUpdatedAt } };
  await db.transaction('rw', table, db.history, async () => {
    await table.put(incoming as never);
    const title = 'title' in payload ? payload.title : payload.taskTitle;
    await db.history.add(history(entityType === 'memo' ? 'system' : entityType, payload.id, 'sync', `他の端末から「${title || 'メモ'}」を反映`, current || null, incoming, 'remote'));
  });
}

export async function markSynced(entityType: 'task' | 'session' | 'memo', id: string, serverUpdatedAt: string): Promise<void> {
  const table = entityType === 'task' ? db.tasks : entityType === 'session' ? db.sessions : db.memos;
  const current = await table.get(id as never) as Task | FocusSession | Memo | undefined;
  if (!current) return;
  await table.put({ ...current, sync: { ...current.sync, serverUpdatedAt } } as never);
}

export async function resolveScheduleConflictWithLocal(taskId: string): Promise<void> {
  const queued = await db.scheduleOutbox.where('taskId').equals(taskId).sortBy('createdAt');
  const revision = queued.find((item) => item.conflictRevision)?.conflictRevision;
  if (!queued.length || !revision) throw new Error('解決する同期競合がありません');
  await db.transaction('rw', db.scheduleOutbox, async () => {
    for (const [index, item] of queued.entries()) {
      if (item.id === undefined) continue;
      await db.scheduleOutbox.update(item.id, {
        baseRevision: index === 0 ? revision : null,
        conflictRevision: null,
        conflictTask: null,
        attempts: 0,
      });
    }
  });
  announceChange();
}

export async function resolveScheduleConflictWithRemote(taskId: string): Promise<void> {
  const queued = await db.scheduleOutbox.where('taskId').equals(taskId).sortBy('createdAt');
  const conflict = queued.find((item) => item.conflictTask && item.conflictRevision);
  if (!conflict?.conflictTask || !conflict.conflictRevision) throw new Error('クラウド側の予定を確認できません');
  const before = await db.tasks.get(taskId);
  if (!before) throw new Error('対象タスクが見つかりません');
  const incoming: Task = {
    ...conflict.conflictTask,
    sync: { ...conflict.conflictTask.sync, serverUpdatedAt: conflict.conflictRevision },
  };
  const at = nowIso();
  const entry: ScheduleHistoryEntry = {
    id: makeId('schedule-operation'),
    taskId,
    operationGroupId: null,
    beforeVersionId: before.scheduleVersionId || null,
    afterVersionId: incoming.scheduleVersionId || null,
    targetVersionId: null,
    operation: 'resolve_conflict',
    result: 'unconfirmed',
    before: scheduleSnapshot(before),
    after: scheduleSnapshot(incoming),
    title: incoming.title,
    occurredAt: at,
    serverReceivedAt: at,
    deviceId: incoming.sync.deviceId,
    source: 'remote',
    relatedEntryId: conflict.operationId,
    reason: 'クラウド側の予定を明示的に採用',
  };
  await db.transaction('rw', [db.tasks, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox], async () => {
    await db.tasks.put(incoming);
    await db.scheduleHistory.put(entry);
    await db.scheduleOutbox.where('taskId').equals(taskId).delete();
    await db.outbox.where('[entityType+entityId]').equals(['task', taskId]).delete();
    await db.history.add(history('task', taskId, 'resolve_conflict', 'クラウド側の予定を採用', before, incoming, 'remote'));
  });
  announceChange();
}

export async function clearAllV2Data(): Promise<void> {
  await db.transaction('rw', [db.tasks, db.sessions, db.memos, db.history, db.outbox, db.scheduleHistory, db.scheduleOutbox], async () => {
    await Promise.all([
      db.tasks.clear(),
      db.sessions.clear(),
      db.memos.clear(),
      db.history.clear(),
      db.outbox.clear(),
      db.scheduleHistory.clear(),
      db.scheduleOutbox.clear(),
    ]);
  });
  announceChange();
}

export function compactDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function todayKey(): string {
  return compactDate(new Date());
}

export function taskStart(task: Task): Date | null {
  if (!task.scheduledDate) return null;
  const [year, month, day] = task.scheduledDate.split('-').map(Number);
  const minute = task.startMinute ?? 9 * 60;
  return new Date(year, month - 1, day, Math.floor(minute / 60), minute % 60);
}

export function cloneForExport<T>(value: T): T {
  return Dexie.deepClone(value);
}
