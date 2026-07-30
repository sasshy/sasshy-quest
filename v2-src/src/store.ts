import Dexie from 'dexie';
import { db, getDeviceId, makeId, nowIso } from './db';
import { predictDuration } from './insights';
import type {
  FocusSession, HistoryEntry, Memo, OutboxItem, Task, TaskHorizon, TaskUndoAction, UndoRedoSetting,
} from './types';

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sasshy-v2-state') : null;
const MAX_UNDO_ACTIONS = 30;

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

export async function getUndoRedoState(): Promise<UndoRedoSetting> {
  const stored = await db.settings.get('undo-redo') as unknown as UndoRedoSetting | undefined;
  return stored || { id: 'undo-redo', undo: [], redo: [] };
}

async function recordUndoAction(before: Task | null, after: Task | null, label: string): Promise<void> {
  const state = await getUndoRedoState();
  const action: TaskUndoAction = {
    id: makeId('undo'),
    label,
    before,
    after,
    expectedUpdatedAt: after?.updatedAt || null,
    createdAt: nowIso(),
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
  const estimateMin = Math.max(5, requestedEstimate ?? prediction?.predictedMin ?? 25);
  const task: Task = {
    id: makeId('task'),
    title: input.title.trim(),
    notes: input.notes?.trim() || '',
    status: scheduledDate ? 'planned' : 'inbox',
    horizon: input.horizon || 'now',
    scheduledDate,
    startMinute: input.startMinute ?? null,
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
  await db.transaction('rw', db.tasks, db.history, db.outbox, db.settings, async () => {
    await db.tasks.add(task);
    await db.history.add(history('task', task.id, 'create', `「${task.title}」を追加`, null, task, source));
    await queueRecord('task', task);
    if (source === 'local') await recordUndoAction(null, task, `「${task.title}」を追加`);
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
  await db.transaction('rw', db.tasks, db.history, db.outbox, db.settings, async () => {
    const before = await db.tasks.get(id);
    if (!before) return;
    const scheduledDate = changes.scheduledDate === undefined ? before.scheduledDate : changes.scheduledDate;
    const next: Task = {
      ...before,
      ...changes,
      status: changes.status || (before.status === 'done' || before.status === 'archived' ? before.status : scheduledDate ? 'planned' : 'inbox'),
      scheduledDate,
      updatedAt: nowIso(),
      sync: { ...before.sync, deviceId },
    };
    await db.tasks.put(next);
    await db.history.add(history('task', id, 'update', label, before, next));
    await queueRecord('task', next);
    if (trackUndo) await recordUndoAction(before, next, label);
    result = next;
  });
  announceChange();
  return result;
}

export async function completeTask(id: string, done: boolean): Promise<Task | null> {
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
  const restored: Task = { ...snapshot, updatedAt: nowIso(), sync: { ...snapshot.sync, deviceId } };
  await db.transaction('rw', db.tasks, db.history, db.outbox, db.settings, async () => {
    await db.tasks.put(restored);
    await db.history.add(history('task', restored.id, 'restore', `「${restored.title}」を履歴から復元`, current || null, restored));
    await queueRecord('task', restored);
    await recordUndoAction(current || null, restored, `「${restored.title}」を履歴から復元`);
  });
  announceChange();
}

async function applyUndoSnapshot(
  action: TaskUndoAction,
  direction: 'undo' | 'redo',
): Promise<{ result: string; restored: Task } | null> {
  const deviceId = await getDeviceId();
  const current = await db.tasks.get(action.after?.id || action.before?.id || '');
  if (!current) return null;
  if (action.expectedUpdatedAt && current.updatedAt !== action.expectedUpdatedAt) return null;
  const target = direction === 'undo' ? action.before : action.after;
  const restored: Task = target
    ? { ...target, updatedAt: nowIso(), sync: { ...target.sync, deviceId } }
    : { ...current, status: 'archived', deletedAt: nowIso(), updatedAt: nowIso(), sync: { ...current.sync, deviceId } };
  await db.tasks.put(restored);
  await db.history.add(history(
    'task',
    restored.id,
    direction,
    `${direction === 'undo' ? '元に戻す' : 'やり直す'}：${action.label}`,
    current,
    restored,
  ));
  await queueRecord('task', restored);
  return {
    result: `${direction === 'undo' ? '元に戻しました' : 'やり直しました'}：${action.label}`,
    restored,
  };
}

export async function undoLatestTaskChange(): Promise<string | null> {
  let message: string | null = null;
  await db.transaction('rw', db.tasks, db.history, db.outbox, db.settings, async () => {
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
      redo: [...state.redo, { ...action, expectedUpdatedAt: applied.restored.updatedAt }].slice(-MAX_UNDO_ACTIONS),
    });
    message = applied.result;
  });
  announceChange();
  return message;
}

export async function redoLatestTaskChange(): Promise<string | null> {
  let message: string | null = null;
  await db.transaction('rw', db.tasks, db.history, db.outbox, db.settings, async () => {
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
      undo: [...state.undo, { ...action, expectedUpdatedAt: applied.restored.updatedAt }].slice(-MAX_UNDO_ACTIONS),
      redo: nextRedo,
    });
    message = applied.result;
  });
  announceChange();
  return message;
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
  await db.transaction('rw', db.sessions, db.tasks, db.history, db.outbox, async () => {
    const running = await db.sessions.where('status').anyOf('running', 'paused').toArray();
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
    if (task.status !== 'done') {
      const active = { ...task, status: 'active' as const, updatedAt: at, sync: { ...task.sync, deviceId } };
      await db.tasks.put(active);
      await queueRecord('task', active);
    }
  });
  announceChange();
  return session;
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

export async function clearAllV2Data(): Promise<void> {
  await db.transaction('rw', db.tasks, db.sessions, db.memos, db.history, db.outbox, async () => {
    await Promise.all([db.tasks.clear(), db.sessions.clear(), db.memos.clear(), db.history.clear(), db.outbox.clear()]);
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
