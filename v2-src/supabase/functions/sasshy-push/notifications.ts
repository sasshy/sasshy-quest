import { workReminderSlot } from '../_shared/work-reminder.ts';
type Json = Record<string, unknown>;

interface StoredRecord {
  workspace_hash: string;
  record_type: 'task' | 'session' | 'memo';
  id: string;
  payload: Json;
}

interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoredSubscription {
  workspace_hash: string;
  endpoint_hash: string;
  subscription: WebPushSubscription;
}

interface Candidate {
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


function text(value: unknown, maximum: number): string { return typeof value === 'string' ? value.trim().slice(0, maximum) : ''; }

function taskNotification(record: StoredRecord): Candidate | null {
  const value = record.payload;
  const date = text(value.scheduledDate, 10);
  if (value.startMinute === null || value.startMinute === undefined) return null;
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

function memoNotification(record: StoredRecord): Candidate | null {
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

function sessionNotifications(record: StoredRecord): Candidate[] {
  const value = record.payload;
  if (text(value.status, 20) !== 'running' || value.deletedAt) return [];
  const startedAt = Date.parse(text(value.startedAt, 40));
  const plannedSec = Number(value.plannedMin) * 60;
  const carriedSec = Number(value.carriedElapsedSec || 0);
  const pausedSec = Number(value.pausedTotalSec || 0);
  const remainingAtStart = plannedSec - carriedSec;
  if (![startedAt, plannedSec, carriedSec, pausedSec].every(Number.isFinite) || remainingAtStart <= 0) return [];
  const baseAt = startedAt + (remainingAtStart + pausedSec) * 1000;
  const taskTitle = text(value.taskTitle, 180) || '実行中のタスク';
  return [
    {
      offsetMin: 0,
      title: 'タイマーが終了しました',
      body: taskTitle,
    },
    {
      offsetMin: 10,
      title: '10分たちました・今どうなっていますか？',
      body: `完了、脱線、継続のどれでも大丈夫です：${taskTitle}`,
    },
    {
      offsetMin: 30,
      title: 'タイマーが残っています',
      body: `押し忘れでも記録を直せます：${taskTitle}`,
    },
  ].map((notice) => ({
    workspaceHash: record.workspace_hash,
    key: `session:${record.id}:${baseAt}:${notice.offsetMin}`,
    at: baseAt + notice.offsetMin * 60_000,
    payload: {
      title: notice.title,
      body: notice.body,
      tag: `sasshy-session-${record.id}`,
      kind: 'timer',
      sourceId: record.id,
      url: './?open=today',
    },
  }));
}

export function candidates(record: StoredRecord, now: number): Candidate[] {
  if (record.record_type === 'task') {
    const notice = taskNotification(record);
    const slot = workReminderSlot(record.payload, now);
    const reminder: Candidate[] = slot === null ? [] : [{
      workspaceHash: record.workspace_hash,
      key: `work:${record.id}:${slot}`,
      at: slot,
      payload: { title: '未対応の仕事があります', body: text(record.payload.title, 180),
        tag: `sasshy-work-${record.id}`, kind: 'work', sourceId: record.id, url: './?open=inbox' },
    }];
    return [...(notice ? [notice] : []), ...reminder];
  }
  if (record.record_type === 'memo') {
    const notice = memoNotification(record);
    return notice ? [notice] : [];
  }
  if (record.record_type === 'session') return sessionNotifications(record);
  return [];
}
