import { hasWorkStartForDate } from './work-start.ts';

type Json = Record<string, unknown>;

export interface StoredRecord {
  workspace_hash: string;
  record_type: 'task' | 'session' | 'memo';
  id: string;
  payload: Json;
}

export interface StandardNotificationCandidate {
  workspaceHash: string;
  key: string;
  at: number;
  payload: {
    title: string;
    body: string;
    tag: string;
    kind: string;
    sourceId: string;
    url: string;
  };
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

/**
 * Existing records did not store an explicit choice. Keep those records on
 * until the user reviews them so a medication or other essential reminder is
 * not silently disabled. All newly-created records store false by default.
 */
export function scheduledStartNotificationEnabled(payload: Json): boolean {
  return payload.scheduledStartNotification !== false;
}

export function taskNotification(record: StoredRecord): StandardNotificationCandidate | null {
  const value = record.payload;
  const date = text(value.scheduledDate, 10);
  if (date && hasWorkStartForDate(value, date)) return null;
  if (!scheduledStartNotificationEnabled(value)) return null;
  const startMinute = Number(value.startMinute);
  if (!date || !Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439) return null;
  if (['done', 'archived'].includes(text(value.status, 20)) || value.deletedAt) return null;
  const hour = String(Math.floor(startMinute / 60)).padStart(2, '0');
  const minute = String(startMinute % 60).padStart(2, '0');
  const at = Date.parse(`${date}T${hour}:${minute}:00+09:00`);
  if (!Number.isFinite(at)) return null;
  return {
    workspaceHash: record.workspace_hash,
    key: `task:${record.id}:${at}`,
    at,
    payload: {
      title: '予定の時間です',
      body: text(value.title, 180) || 'SASSHYのタスクを確認してください',
      tag: `sasshy-task-${record.id}`,
      kind: 'task',
      sourceId: record.id,
      url: './?open=calendar',
    },
  };
}

export function memoNotification(record: StoredRecord): StandardNotificationCandidate | null {
  const value = record.payload;
  if (value.archived || value.deletedAt) return null;
  const at = Date.parse(text(value.reminderAt, 40));
  if (!Number.isFinite(at)) return null;
  return {
    workspaceHash: record.workspace_hash,
    key: `memo:${record.id}:${at}`,
    at,
    payload: {
      title: text(value.title, 120) || 'SASSHYメモ',
      body: text(value.body, 180) || '設定した時刻になりました',
      tag: `sasshy-memo-${record.id}`,
      kind: 'memo',
      sourceId: record.id,
      url: './?open=memos',
    },
  };
}

/** A running timer produces one end notification and no automatic follow-up. */
export function sessionNotification(record: StoredRecord): StandardNotificationCandidate | null {
  const value = record.payload;
  if (text(value.status, 20) !== 'running' || value.deletedAt) return null;
  const startedAt = Date.parse(text(value.startedAt, 40));
  const plannedSec = Number(value.plannedMin) * 60;
  const carriedSec = Number(value.carriedElapsedSec || 0);
  const pausedSec = Number(value.pausedTotalSec || 0);
  const remainingAtStart = plannedSec - carriedSec;
  if (![startedAt, plannedSec, carriedSec, pausedSec].every(Number.isFinite) || remainingAtStart <= 0) return null;
  const at = startedAt + (remainingAtStart + pausedSec) * 1000;
  return {
    workspaceHash: record.workspace_hash,
    key: `session:${record.id}:${at}`,
    at,
    payload: {
      title: 'タイマーが終了しました',
      body: text(value.taskTitle, 180) || '予定時間になりました',
      tag: `sasshy-session-${record.id}`,
      kind: 'timer',
      sourceId: record.id,
      url: './?open=today',
    },
  };
}

export function standardNotificationCandidates(record: StoredRecord): StandardNotificationCandidate[] {
  const candidate = record.record_type === 'task'
    ? taskNotification(record)
    : record.record_type === 'memo'
      ? memoNotification(record)
      : record.record_type === 'session'
        ? sessionNotification(record)
        : null;
  return candidate ? [candidate] : [];
}

export function dueStandardNotificationCandidates(
  candidates: StandardNotificationCandidate[],
  now: number,
): StandardNotificationCandidate[] {
  return candidates.filter((item) => item.at >= now - 10 * 60_000 && item.at <= now);
}
