import type { TaskHorizon } from './types';

export interface TaskLinkPayload {
  v: 1;
  requestId: string;
  title: string;
  notes?: string;
  scheduledDate?: string | null;
  startTime?: string | null;
  durationMin?: number;
  importance?: 0 | 1 | 2;
  urgency?: 0 | 1 | 2;
  horizon?: TaskHorizon;
}

export interface ParsedTaskLink {
  requestId: string;
  title: string;
  notes: string;
  scheduledDate: string | null;
  startMinute: number | null;
  durationMin: number;
  importance: 0 | 1 | 2;
  urgency: 0 | 1 | 2;
  horizon: TaskHorizon;
}

export interface TaskLinkResult {
  hasTask: boolean;
  task: ParsedTaskLink | null;
  error: string;
}

function encodeUtf8Base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeUtf8Base64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('リンクの形式が正しくありません');
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('リンク内の文字項目が正しくありません');
  const result = value.trim();
  if (result.length > maxLength) throw new Error('リンク内の文字数が多すぎます');
  return result;
}

function priority(value: unknown): 0 | 1 | 2 {
  if (value === undefined || value === null) return 0;
  if (value !== 0 && value !== 1 && value !== 2) throw new Error('優先度の指定が正しくありません');
  return value;
}

export function parseTaskLink(url: string): TaskLinkResult {
  const encoded = new URL(url).searchParams.get('task');
  if (!encoded) return { hasTask: false, task: null, error: '' };
  if (encoded.length > 8_000) return { hasTask: true, task: null, error: 'タスク追加リンクが長すぎます' };

  try {
    const raw = JSON.parse(decodeUtf8Base64Url(encoded)) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || raw.v !== 1) throw new Error('対応していないタスク追加リンクです');

    const requestId = optionalText(raw.requestId, 128);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new Error('リンクの受付番号が正しくありません');
    const title = optionalText(raw.title, 200);
    if (!title) throw new Error('タスク名がありません');
    const notes = optionalText(raw.notes, 4_000);
    const scheduledDate = optionalText(raw.scheduledDate, 10);
    if (scheduledDate && !validDate(scheduledDate)) throw new Error('予定日が正しくありません');

    const startTime = optionalText(raw.startTime, 5);
    let startMinute: number | null = null;
    if (startTime) {
      if (!scheduledDate) throw new Error('時刻を指定するときは予定日が必要です');
      const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(startTime);
      if (!match) throw new Error('開始時刻が正しくありません');
      startMinute = Number(match[1]) * 60 + Number(match[2]);
    }

    const durationMin = raw.durationMin === undefined ? 25 : raw.durationMin;
    if (!Number.isInteger(durationMin) || Number(durationMin) < 5 || Number(durationMin) > 720) {
      throw new Error('所要時間が正しくありません');
    }
    const horizon = raw.horizon === undefined ? 'now' : raw.horizon;
    if (!['now', 'someday', 'wish', 'waiting'].includes(String(horizon))) {
      throw new Error('タスクの分類が正しくありません');
    }

    return {
      hasTask: true,
      task: {
        requestId,
        title,
        notes,
        scheduledDate: scheduledDate || null,
        startMinute,
        durationMin: Number(durationMin),
        importance: priority(raw.importance),
        urgency: priority(raw.urgency),
        horizon: String(horizon) as TaskHorizon,
      },
      error: '',
    };
  } catch (error) {
    return {
      hasTask: true,
      task: null,
      error: error instanceof Error ? error.message : 'タスク追加リンクを読み込めませんでした',
    };
  }
}

export function clearTaskLinkFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('task');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function createTaskLink(baseUrl: string, payload: TaskLinkPayload): string {
  const url = new URL(baseUrl);
  url.searchParams.set('task', encodeUtf8Base64Url(JSON.stringify(payload)));
  return url.toString();
}
