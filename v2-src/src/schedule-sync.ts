import { db } from './db';
import type { ScheduleHistoryEntry, ScheduleOutboxItem, SyncConfig, Task } from './types';

interface ApplyResponse {
  ok: boolean;
  conflict?: boolean;
  revision?: string;
  serverRevision?: string;
  serverTask?: Task;
  history?: ScheduleHistoryEntry;
  error?: string;
}

interface ListResponse {
  ok: boolean;
  history: ScheduleHistoryEntry[];
  error?: string;
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

function cleanKey(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '').replace(/\s+/g, '');
}

async function request<T>(config: SyncConfig, action: string, body: Record<string, unknown>): Promise<T> {
  const key = cleanKey(config.apiKey);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${cleanUrl(config.url)}/functions/v1/sasshy-schedule-history/${action}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `予定履歴サーバーに接続できません（${response.status}）`);
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('予定履歴の同期がタイムアウトしました');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function markConflict(item: ScheduleOutboxItem, response: ApplyResponse): Promise<never> {
  if (item.id !== undefined) {
    await db.scheduleOutbox.update(item.id, {
      attempts: item.attempts + 1,
      conflictRevision: response.serverRevision || null,
      conflictTask: response.serverTask || null,
    });
  }
  throw new Error('予定が別の端末でも変更されています。タスク詳細で採用する予定を選んでください');
}

export async function syncScheduleHistory(config: SyncConfig): Promise<number> {
  const queued = await db.scheduleOutbox.orderBy('createdAt').toArray();
  const revisionByTask = new Map<string, string | null>();
  for (const item of queued) {
    if (item.conflictRevision) {
      throw new Error('予定の同期競合が未解決です。タスク詳細で採用する予定を選んでください');
    }
    const baseRevision = revisionByTask.has(item.taskId)
      ? revisionByTask.get(item.taskId) || null
      : item.baseRevision;
    const response = await request<ApplyResponse>(config, 'apply', {
      syncKey: config.syncKey,
      operationId: item.operationId,
      taskId: item.taskId,
      baseRevision,
      task: item.taskPayload,
      updateTask: item.updateTask,
      history: item.history,
    });
    if (response.conflict) await markConflict(item, response);
    if (!response.ok || !response.revision) throw new Error(response.error || '予定履歴を保存できませんでした');
    revisionByTask.set(item.taskId, response.revision);
    await db.transaction('rw', db.tasks, db.scheduleHistory, db.scheduleOutbox, async () => {
      const current = await db.tasks.get(item.taskId);
      if (item.updateTask && current?.updatedAt === item.taskPayload.updatedAt) {
        await db.tasks.put({ ...current, sync: { ...current.sync, serverUpdatedAt: response.revision } });
      }
      if (response.history) await db.scheduleHistory.put(response.history);
      else await db.scheduleHistory.update(item.operationId, { serverReceivedAt: new Date().toISOString() });
      if (item.id !== undefined) await db.scheduleOutbox.delete(item.id);
    });
  }

  let pulled: ListResponse;
  try {
    const response = await request<unknown>(config, 'list', { syncKey: config.syncKey });
    if (
      !response ||
      typeof response !== 'object' ||
      !('ok' in response) ||
      !('history' in response) ||
      !Array.isArray((response as ListResponse).history)
    ) {
      if (!queued.length) return 0;
      throw new Error('予定履歴サーバーの応答形式を確認できませんでした');
    }
    pulled = response as ListResponse;
  } catch (error) {
    if (!queued.length && error instanceof Error && /（404）/.test(error.message)) return 0;
    throw error;
  }
  if (!pulled.ok) throw new Error(pulled.error || '予定履歴を取得できませんでした');
  if (pulled.history?.length) await db.scheduleHistory.bulkPut(pulled.history);
  return pulled.history?.length || 0;
}
