import { db } from './db';
import { getSyncConfig } from './sync';
import type { AppSetting, PushConfig, SyncConfig } from './types';

interface PushServerConfig {
  publicKey: string;
}

interface PushResponse {
  ok: boolean;
  message?: string;
}

export interface PushSupport {
  supported: boolean;
  installed: boolean;
  permission: NotificationPermission | 'unsupported';
  reason: string;
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

function cleanKey(value: string): string {
  return value.trim().replace(/^['"`]|['"`]$/g, '').replace(/\s+/g, '');
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function getPushSupport(): PushSupport {
  const supported = 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
  if (!supported) {
    return {
      supported: false,
      installed: false,
      permission: 'unsupported',
      reason: 'このブラウザはバックグラウンド通知に対応していません',
    };
  }
  const installed = !isIos() || isStandalone();
  return {
    supported: true,
    installed,
    permission: Notification.permission,
    reason: installed
      ? ''
      : 'iPhoneではSafariの共有メニューから「ホーム画面に追加」して、そのアイコンから開いてください',
  };
}

export async function getPushConfig(): Promise<PushConfig> {
  const stored = await db.settings.get('push') as unknown as PushConfig | undefined;
  return stored || {
    id: 'push',
    enabled: false,
    endpoint: '',
    deviceName: '',
    lastRegisteredAt: null,
    lastTestAt: null,
    lastError: '',
  };
}

async function savePushConfig(changes: Partial<PushConfig>): Promise<PushConfig> {
  const current = await getPushConfig();
  const next: PushConfig = { ...current, ...changes, id: 'push' };
  await db.settings.put(next as unknown as AppSetting);
  return next;
}

function validateSync(config: SyncConfig): void {
  if (!config.url || !config.apiKey || !config.syncKey) {
    throw new Error('先にMac・iPhone同期のURL、API key、同期キーを保存してください');
  }
  if (config.syncKey.length < 12) throw new Error('同期キーが短すぎます');
}

function functionHeaders(config: SyncConfig): HeadersInit {
  const key = cleanKey(config.apiKey);
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function pushRequest<T>(
  config: SyncConfig,
  action: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `${cleanUrl(config.url)}/functions/v1/sasshy-push/${action}`,
      {
        method: body ? 'POST' : 'GET',
        headers: functionHeaders(config),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `通知サーバーに接続できません（${response.status}）`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('通知サーバーとの通信がタイムアウトしました');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0))).buffer;
}

function deviceName(): string {
  if (isIos()) return 'iPhone / iPad';
  if (/macintosh/i.test(navigator.userAgent)) return 'Mac';
  return 'ブラウザ';
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('./sw.js');
  return navigator.serviceWorker.ready;
}

export async function enablePushNotifications(): Promise<PushConfig> {
  const support = getPushSupport();
  if (!support.supported || !support.installed) throw new Error(support.reason);

  const config = await getSyncConfig();
  validateSync(config);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('通知が許可されませんでした。iPhoneの設定からSASSHYの通知を許可してください');
  }

  const registration = await serviceWorkerRegistration();
  const server = await pushRequest<PushServerConfig>(config, 'config');
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && subscription.options.applicationServerKey) {
    const currentKey = btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (currentKey !== server.publicKey) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  subscription ||= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(server.publicKey),
  });

  const name = deviceName();
  await pushRequest<PushResponse>(config, 'subscribe', {
    syncKey: config.syncKey,
    subscription: subscription.toJSON(),
    deviceName: name,
  });
  return savePushConfig({
    enabled: true,
    endpoint: subscription.endpoint,
    deviceName: name,
    lastRegisteredAt: new Date().toISOString(),
    lastError: '',
  });
}

export async function disablePushNotifications(): Promise<PushConfig> {
  const config = await getSyncConfig();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && config.url && config.apiKey && config.syncKey) {
    await pushRequest<PushResponse>(config, 'unsubscribe', {
      syncKey: config.syncKey,
      endpoint: subscription.endpoint,
    }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return savePushConfig({ enabled: false, endpoint: '', lastError: '' });
}

export async function testPushNotification(): Promise<PushConfig> {
  const current = await getPushConfig();
  if (!current.enabled) throw new Error('先に「この端末で通知を有効」を押してください');
  const config = await getSyncConfig();
  validateSync(config);
  const response = await pushRequest<PushResponse>(config, 'test', {
    syncKey: config.syncKey,
    endpoint: current.endpoint,
  });
  if (!response.ok) throw new Error(response.message || 'テスト通知を送信できませんでした');
  return savePushConfig({
    lastTestAt: new Date().toISOString(),
    lastError: '',
    enabled: true,
  });
}
