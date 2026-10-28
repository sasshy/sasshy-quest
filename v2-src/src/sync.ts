import { db, getDeviceId } from './db';
import { announceChange, applyRemoteRecord, markSynced } from './store';
import { syncScheduleHistory } from './schedule-sync';
import type { CloudRecord, OutboxItem, SyncConfig } from './types';

export interface SyncState {
  phase: 'idle' | 'syncing' | 'ok' | 'error' | 'offline' | 'disabled';
  message: string;
  at: string | null;
}

let currentState: SyncState = { phase: 'idle', message: '端末に保存済み', at: null };
let running: Promise<void> | null = null;
let rerunRequested = false;
let rerunForce = false;
let interactionDepth = 0;
const listeners = new Set<(state: SyncState) => void>();

export function getSyncState(): SyncState {
  return currentState;
}

export function subscribeSync(callback: (state: SyncState) => void): () => void {
  listeners.add(callback);
  callback(currentState);
  return () => listeners.delete(callback);
}

function setState(next: SyncState): void {
  currentState = next;
  listeners.forEach((listener) => listener(next));
}

export function setInteractionActive(active: boolean): void {
  interactionDepth = Math.max(0, interactionDepth + (active ? 1 : -1));
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

function cleanKey(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '').replace(/\s+/g, '');
}

function headers(config: SyncConfig): HeadersInit {
  const key = cleanKey(config.apiKey);
  const result: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.split('.').length === 3) result.Authorization = `Bearer ${key}`;
  return result;
}

async function responseError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = await response.json();
    detail = body.message || body.error || body.hint || '';
  } catch {
    detail = await response.text().catch(() => '');
  }
  return new Error(`${response.status} ${detail}`.trim());
}

/** 同期の各段階の結果を端末に少しだけ残す（原因を後から調べるため。キーは残さない）。 */
export function syncLog(stage: string, message: string): void {
  try {
    const list = JSON.parse(localStorage.getItem('sasshy-sync-log') || '[]') as unknown[];
    list.unshift({ at: new Date().toISOString(), stage, message: message.slice(0, 200) });
    localStorage.setItem('sasshy-sync-log', JSON.stringify(list.slice(0, 30)));
  } catch { /* 残せなくても同期は続ける */ }
}

async function rpc<T>(config: SyncConfig, name: string, body: Record<string, unknown>, query = ''): Promise<T> {
  try {
    return await rpcOnce<T>(config, name, body, query);
  } catch (error) {
    // 一瞬の通信切れ（アプリの切り替え直後など）は1回だけやり直す。
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('通信')) throw error;
    syncLog(`${name}:retry`, message);
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    return rpcOnce<T>(config, name, body, query);
  }
}

/**
 * サーバーは1回に1000件までしか返さない。少しずつ重ねながら最後まで受け取り、
 * 同じ記録は新しい方だけ残す（記録が1000件を超えて、新しい分が届かなくなっていた）。
 */
const PAGE = 1000;
const STEP = 900;
export const pullAllForTest = (config: SyncConfig) => pullAll(config);
async function pullAll(config: SyncConfig): Promise<CloudRecord[]> {
  const byKey = new Map<string, CloudRecord>();
  for (let offset = 0; offset < 100_000; offset += STEP) {
    const page = await rpc<CloudRecord[]>(config, 'sasshy_v2_pull', { p_sync_key: config.syncKey }, `?limit=${PAGE}&offset=${offset}`) || [];
    for (const row of page) {
      const key = `${row.record_type}:${row.id}`;
      const seen = byKey.get(key);
      if (!seen || Date.parse(row.updated_at) >= Date.parse(seen.updated_at)) byKey.set(key, row);
    }
    if (page.length < PAGE) break;
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
}

async function rpcOnce<T>(config: SyncConfig, name: string, body: Record<string, unknown>, query = ''): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${cleanUrl(config.url)}/rest/v1/rpc/${name}${query}`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) throw new Error('通信がタイムアウトしました。画面を開いたまま再同期します');
    throw new Error('通信できません。URL、API key、ネット接続を確認してください');
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch (error) {
    throw new Error(`通信の途中で切れました（${name}）: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getSyncConfig(): Promise<SyncConfig> {
  const value = await db.settings.get('sync');
  return value as unknown as SyncConfig;
}

export async function saveSyncConfig(input: Partial<SyncConfig>): Promise<SyncConfig> {
  const current = await getSyncConfig();
  const next: SyncConfig = {
    ...current,
    ...input,
    id: 'sync',
    url: cleanUrl(input.url ?? current.url),
    apiKey: cleanKey(input.apiKey ?? current.apiKey),
    syncKey: (input.syncKey ?? current.syncKey).trim(),
  };
  const changesCredential = Boolean(current.syncKey) &&
    (next.syncKey !== current.syncKey || next.url !== current.url);
  if (changesCredential) {
    if (next.url !== current.url) throw new Error('同期先URLの変更は移行手順で行ってください。端末のデータと設定は保持されています');
    validate(next);
    const oldWorkspace = current.workspaceId ?? await connectionWorkspace(current);
    const newWorkspace = await connectionWorkspace(next);
    if (oldWorkspace !== newWorkspace) throw new Error('新しい同期キーは別の保存先です。端末のデータと設定は変更していません');
    next.workspaceId = oldWorkspace;
  } else {
    // The permanent workspace identity is server-verified, never editable input.
    next.workspaceId = current.workspaceId;
  }
  await db.transaction('rw', db.settings, async () => {
    const latest = await getSyncConfig();
    if (latest.syncKey !== current.syncKey || latest.url !== current.url) {
      throw new Error('同期設定が別の操作で変わりました。画面を開き直してください');
    }
    next.lastSyncAt = input.lastSyncAt !== undefined ? input.lastSyncAt : latest.lastSyncAt;
    next.lastError = input.lastError !== undefined ? input.lastError : latest.lastError;
    await db.settings.put(next as unknown as import('./types').AppSetting);
  });
  announceChange();
  return next;
}

async function connectionWorkspace(config: SyncConfig): Promise<string> {
  let info: { workspaceId?: string };
  try { info = await rpc(config, 'sasshy_v2_connection_info', { p_sync_key: config.syncKey }); }
  catch { throw new Error('同期キーの保存先を確認できませんでした。端末のデータと設定は保持されています'); }
  if (!info || typeof info.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(info.workspaceId)) {
    throw new Error('同期先の確認に対応したサーバーが必要です。設定は変更していません');
  }
  return info.workspaceId;
}

function validate(config: SyncConfig): void {
  if (!config.url || !config.apiKey || !config.syncKey) throw new Error('同期設定が未入力です');
  if (!/^https:\/\/.+\.supabase\.co$/i.test(config.url)) throw new Error('Supabase URLの形式を確認してください');
  if (/^sb_secret_/i.test(config.apiKey)) throw new Error('secret keyではなくpublishable keyを使ってください');
}

async function performSync(force = false): Promise<void> {
  const config = await getSyncConfig();
  if (!config.enabled && !force) {
    const pendingCount = await db.outbox.count();
    setState({ phase: 'disabled', message: `自動同期 OFF・未送信${pendingCount}件（端末保存済み）`, at: config.lastSyncAt });
    return;
  }
  validate(config);
  if (!navigator.onLine) {
    setState({ phase: 'offline', message: 'オフライン・端末保存済み', at: config.lastSyncAt });
    return;
  }
  if (interactionDepth > 0 && !force) return;

  setState({ phase: 'syncing', message: '1件ずつ安全同期中', at: config.lastSyncAt });
  try {
    const scheduleHistoryCount = await syncScheduleHistory(config);
    const queued = await db.outbox.orderBy('createdAt').toArray();
    let failed = 0;
    let conflicts = 0;
    let firstFailure = '';
    for (const item of queued) {
      try {
        const outcome = await pushItem(config, item);
        if (outcome === 'conflict') conflicts += 1;
        if (item.id !== undefined) await db.outbox.delete(item.id);
      } catch (error) {
        // Auth and connection problems affect every record: stop and keep everything queued.
        if (isFatalSyncError(error)) throw error;
        // A problem with one record must not block the others (it stays queued for the next sync).
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (!firstFailure) firstFailure = message;
        if (item.id !== undefined) {
          await db.outbox.update(item.id, {
            attempts: (item.attempts || 0) + 1,
            lastError: message.slice(0, 300),
            lastAttemptAt: new Date().toISOString(),
          });
        }
      }
    }

    const remote = await pullAll(config);
    let applyFailed = 0;
    for (const record of remote || []) {
      // 1件が読めなくても、残りは必ず反映する。
      try {
        const pending = await db.outbox.where('[entityType+entityId]').equals([record.record_type, record.id]).first();
        const pendingSchedule = record.record_type === 'task'
          ? await db.scheduleOutbox.where('taskId').equals(record.id).first()
          : undefined;
        if (pending || pendingSchedule) continue;
        await applyRemoteRecord(record.record_type, record.payload, record.deleted, record.updated_at);
      } catch (error) {
        applyFailed += 1;
        if (applyFailed <= 3) syncLog('apply', `${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    syncLog('pull', `ok ${remote?.length || 0}件${applyFailed ? `・反映できず${applyFailed}件` : ''}`);

    const at = new Date().toISOString();
    const pendingCount = await db.outbox.count();
    if (failed > 0) {
      await saveSyncConfig({ lastSyncAt: at, lastError: firstFailure });
      setState({ phase: 'error', message: `一部未送信・未送信${pendingCount}件（次回再送）: ${firstFailure}`, at });
    } else {
      await saveSyncConfig({ lastSyncAt: at, lastError: '' });
      const conflictText = conflicts > 0 ? `・競合${conflicts}件は履歴に保存` : '';
      setState({ phase: 'ok', message: `クラウド保存済み・${remote?.length || 0}件／予定履歴${scheduleHistoryCount}件確認・未送信${pendingCount}件${conflictText}`, at });
    }
    announceChange();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    syncLog('sync', message);
    await saveSyncConfig({ lastError: message });
    const pendingCount = await db.outbox.count().catch(() => 0);
    setState({ phase: 'error', message: `同期失敗・未送信${pendingCount}件は端末に保持: ${message}`, at: config.lastSyncAt });
    throw error;
  }
}

/** Errors that will fail for every record too: authentication, missing setup or no connection. */
export function isFatalSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(401|403)\b/.test(message)
    || /28000|invalid credential/i.test(message)
    || message.startsWith('通信');
}

function isMissingFunction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^404\b/.test(message) || /PGRST202|Could not find the function/i.test(message);
}

type PushIfResult = { status: 'ok' | 'conflict'; row: CloudRecord | null };

// null = not yet known. Older servers without sasshy_v2_push_if fall back to the legacy push.
let pushIfSupported: boolean | null = null;

async function pushItem(config: SyncConfig, item: OutboxItem): Promise<'ok' | 'conflict'> {
  const base = (item.payload as { sync?: { serverUpdatedAt?: string | null } }).sync?.serverUpdatedAt ?? null;
  if (pushIfSupported !== false) {
    try {
      let result = await pushIf(config, item, base);
      pushIfSupported = true;
      if (result.status === 'conflict' && result.row) {
        // The newer server version was written by this same device (e.g. an edit queued
        // while the previous push was in flight): not a real conflict, so overwrite it.
        const writer = (result.row.payload as { sync?: { deviceId?: string } }).sync?.deviceId;
        if (writer && writer === await getDeviceId()) result = await pushIf(config, item, result.row.updated_at);
      }
      if (result.status === 'ok') {
        if (result.row) await markSynced(item.entityType, item.entityId, result.row.updated_at);
        return 'ok';
      }
      if (result.row) await keepLocalAsConflict(item, result.row);
      return 'conflict';
    } catch (error) {
      if (!isMissingFunction(error)) throw error;
      pushIfSupported = false;
    }
  }
  const response = await rpc<CloudRecord[]>(config, 'sasshy_v2_push', {
    p_sync_key: config.syncKey,
    p_record_type: item.entityType,
    p_id: item.entityId,
    p_payload: item.payload,
    p_deleted: item.deleted,
  });
  const row = response?.[0];
  if (row) await markSynced(item.entityType, item.entityId, row.updated_at);
  return 'ok';
}

function pushIf(config: SyncConfig, item: OutboxItem, base: string | null): Promise<PushIfResult> {
  return rpc<PushIfResult>(config, 'sasshy_v2_push_if', {
    p_sync_key: config.syncKey,
    p_record_type: item.entityType,
    p_id: item.entityId,
    p_payload: item.payload,
    p_deleted: item.deleted,
    p_base_updated_at: base,
  });
}

/** Never lose either side: keep this device's edit in history and show the cloud version. */
async function keepLocalAsConflict(item: OutboxItem, row: CloudRecord): Promise<void> {
  const payload = item.payload as { id: string; title?: string; taskTitle?: string };
  const title = payload.title || payload.taskTitle || 'メモ';
  await db.history.add({
    id: `history-conflict-${item.entityId}-${Date.now()}`,
    entityType: item.entityType === 'memo' ? 'system' : item.entityType,
    entityId: item.entityId,
    action: 'sync-conflict',
    label: `同期の競合：「${title}」のこの端末での変更を履歴に保存し、他の端末の内容を表示`,
    before: item.payload,
    after: row.payload,
    createdAt: new Date().toISOString(),
    source: 'local',
  });
  await applyRemoteRecord(row.record_type, row.payload, row.deleted, row.updated_at);
}

export function syncNow(force = false): Promise<void> {
  if (running) {
    rerunRequested = true;
    rerunForce ||= force;
    return running;
  }
  const request = performSync(force);
  running = request;
  const finished = () => {
    if (running !== request) return;
    running = null;
    if (!rerunRequested) return;
    const forceNext = rerunForce;
    rerunRequested = false;
    rerunForce = false;
    window.setTimeout(() => syncNow(forceNext).catch(() => undefined), 0);
  };
  void request.then(finished, finished);
  return request;
}

export async function testSyncConnection(configInput?: Partial<SyncConfig>): Promise<number> {
  const config = configInput ? await saveSyncConfig(configInput) : await getSyncConfig();
  validate(config);
  const rows = await pullAll(config);
  // First-time setup: a verified connection should not silently stay in manual mode
  // (unsent edits piled up unnoticed before). A user who later turns it off keeps that choice.
  if (!config.enabled && !config.lastSyncAt) await saveSyncConfig({ enabled: true });
  return rows.length;
}

export function startAutoSync(): () => void {
  const trySync = () => { if (interactionDepth === 0) syncNow().catch(() => undefined); };
  const resume = () => {
    if (document.hidden) return;
    interactionDepth = 0;
    trySync();
  };
  const interval = window.setInterval(trySync, 15_000);
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('pageshow', resume);
  const visible = () => { if (!document.hidden) resume(); };
  document.addEventListener('visibilitychange', visible);
  window.setTimeout(resume, 300);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener('online', resume);
    window.removeEventListener('focus', resume);
    window.removeEventListener('pageshow', resume);
    document.removeEventListener('visibilitychange', visible);
  };
}
