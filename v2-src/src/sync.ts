import { db } from './db';
import { announceChange, applyRemoteRecord, markSynced } from './store';
import type { CloudRecord, SyncConfig } from './types';

export interface SyncState {
  phase: 'idle' | 'syncing' | 'ok' | 'error' | 'offline' | 'disabled';
  message: string;
  at: string | null;
}

let currentState: SyncState = { phase: 'idle', message: '端末に保存済み', at: null };
let running: Promise<void> | null = null;
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

async function rpc<T>(config: SyncConfig, name: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${cleanUrl(config.url)}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('通信できません。URL、API key、ネット接続を確認してください');
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
  await db.settings.put(next as unknown as import('./types').AppSetting);
  announceChange();
  return next;
}

function validate(config: SyncConfig): void {
  if (!config.url || !config.apiKey || !config.syncKey) throw new Error('同期設定が未入力です');
  if (!/^https:\/\/.+\.supabase\.co$/i.test(config.url)) throw new Error('Supabase URLの形式を確認してください');
  if (/^sb_secret_/i.test(config.apiKey)) throw new Error('secret keyではなくpublishable keyを使ってください');
}

async function performSync(force = false): Promise<void> {
  const config = await getSyncConfig();
  if (!config.enabled && !force) {
    setState({ phase: 'disabled', message: '自動同期 OFF・端末保存済み', at: config.lastSyncAt });
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
    const queued = await db.outbox.orderBy('createdAt').toArray();
    for (const item of queued) {
      const response = await rpc<CloudRecord[]>(config, 'sasshy_v2_push', {
        p_sync_key: config.syncKey,
        p_record_type: item.entityType,
        p_id: item.entityId,
        p_payload: item.payload,
        p_deleted: item.deleted,
      });
      const row = response?.[0];
      if (row) await markSynced(item.entityType, item.entityId, row.updated_at);
      if (item.id !== undefined) await db.outbox.delete(item.id);
    }

    const remote = await rpc<CloudRecord[]>(config, 'sasshy_v2_pull', { p_sync_key: config.syncKey });
    for (const record of remote || []) {
      const pending = await db.outbox.where('[entityType+entityId]').equals([record.record_type, record.id]).first();
      if (pending) continue;
      await applyRemoteRecord(record.record_type, record.payload, record.deleted, record.updated_at);
    }

    const at = new Date().toISOString();
    await saveSyncConfig({ lastSyncAt: at, lastError: '' });
    setState({ phase: 'ok', message: `クラウド保存済み・${remote?.length || 0}件確認`, at });
    announceChange();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveSyncConfig({ lastError: message });
    setState({ phase: 'error', message: `同期失敗・端末データは保持: ${message}`, at: config.lastSyncAt });
    throw error;
  }
}

export function syncNow(force = false): Promise<void> {
  if (running) return running;
  running = performSync(force).finally(() => { running = null; });
  return running;
}

export async function testSyncConnection(configInput?: Partial<SyncConfig>): Promise<number> {
  const config = configInput ? await saveSyncConfig(configInput) : await getSyncConfig();
  validate(config);
  const rows = await rpc<CloudRecord[]>(config, 'sasshy_v2_pull', { p_sync_key: config.syncKey });
  return rows.length;
}

export function startAutoSync(): () => void {
  const trySync = () => { if (interactionDepth === 0) syncNow().catch(() => undefined); };
  const interval = window.setInterval(trySync, 30_000);
  const online = () => trySync();
  const visible = () => { if (!document.hidden) trySync(); };
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', visible);
  window.setTimeout(trySync, 1_200);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener('online', online);
    document.removeEventListener('visibilitychange', visible);
  };
}
