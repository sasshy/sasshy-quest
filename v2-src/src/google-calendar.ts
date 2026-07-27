import { db } from './db';
import type { GoogleCalendarConfig, GoogleCalendarEvent } from './types';

export const emptyGoogleCalendar: GoogleCalendarConfig = {
  id: 'google-calendar',
  enabled: false,
  feedUrl: '',
  events: [],
  lastSyncAt: null,
  lastError: '',
};

function dateRangeUrl(value: string, callback = ''): string {
  const from = new Date();
  from.setDate(from.getDate() - 45);
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setDate(to.getDate() + 180);
  to.setHours(23, 59, 59, 999);
  const url = new URL(value);
  if (!url.searchParams.has('from')) url.searchParams.set('from', from.toISOString());
  if (!url.searchParams.has('to')) url.searchParams.set('to', to.toISOString());
  if (callback) url.searchParams.set('callback', callback);
  return url.toString();
}

function normalizedDate(value: unknown): Date | null {
  if (!value) return null;
  const text = String(value).trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (compact) {
    const [, year, month, day, hour = '00', minute = '00', second = '00', utc] = compact;
    return utc
      ? new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second))
      : new Date(+year, +month - 1, +day, +hour, +minute, +second);
  }
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeEvents(payload: unknown): GoogleCalendarEvent[] {
  const list = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown[] }).events) ? (payload as { events: unknown[] }).events : [];
  return list.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const event = raw as Record<string, unknown>;
    const startValue = event.start ?? event.startTime ?? event.startDate ?? event.dtstart;
    const endValue = event.end ?? event.endTime ?? event.endDate ?? event.dtend;
    const startDate = normalizedDate(startValue);
    if (!startDate) return [];
    const textStart = String(startValue || '');
    const allDay = Boolean(event.allDay) || /^\d{4}-\d{2}-\d{2}$/.test(textStart) || /^\d{8}$/.test(textStart);
    const endDate = normalizedDate(endValue);
    return [{
      id: String(event.id ?? event.uid ?? `google-${index}-${textStart}`),
      title: String(event.title ?? event.summary ?? event.name ?? '(無題)'),
      start: allDay ? localDateKey(startDate) : startDate.toISOString(),
      end: endDate ? (allDay ? localDateKey(endDate) : endDate.toISOString()) : null,
      allDay,
      calendarName: String(event.calendarName ?? event.calendar_name ?? event.calendarTitle ?? ''),
      color: String(event.calendarColor ?? event.calendar_color ?? event.color ?? ''),
    }];
  }).sort((a, b) => a.start.localeCompare(b.start));
}

function jsonp(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callback = `sasshyV2Google_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timer = window.setTimeout(() => finish(new Error('Googleカレンダーから応答がありませんでした')), 18_000);
    const finish = (error?: Error, data?: unknown) => {
      window.clearTimeout(timer);
      script.remove();
      delete (window as unknown as Record<string, unknown>)[callback];
      if (error) reject(error); else resolve(data);
    };
    (window as unknown as Record<string, unknown>)[callback] = (data: unknown) => finish(undefined, data);
    script.onerror = () => finish(new Error('Apps Script URLを読み込めませんでした'));
    script.src = dateRangeUrl(url, callback);
    document.body.appendChild(script);
  });
}

export async function getGoogleCalendarConfig(): Promise<GoogleCalendarConfig> {
  return (await db.settings.get('google-calendar') as unknown as GoogleCalendarConfig | undefined) || emptyGoogleCalendar;
}

export async function saveGoogleCalendarConfig(config: GoogleCalendarConfig): Promise<void> {
  await db.settings.put({ ...config, id: 'google-calendar' });
}

export async function refreshGoogleCalendar(config?: GoogleCalendarConfig): Promise<GoogleCalendarConfig> {
  const current = config || await getGoogleCalendarConfig();
  if (!current.feedUrl.trim()) throw new Error('Apps ScriptのURLを入力してください');
  try {
    let data: unknown;
    if (/^https:\/\/script\.google\.com\/macros\/s\//i.test(current.feedUrl)) data = await jsonp(current.feedUrl);
    else {
      const response = await fetch(dateRangeUrl(current.feedUrl), { cache: 'no-store' });
      if (!response.ok) throw new Error(`読込エラー ${response.status}`);
      data = await response.json();
    }
    const next = { ...current, enabled: true, events: normalizeEvents(data), lastSyncAt: new Date().toISOString(), lastError: '' };
    await saveGoogleCalendarConfig(next);
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveGoogleCalendarConfig({ ...current, lastError: message });
    throw new Error(`Googleカレンダーを読み込めませんでした: ${message}`);
  }
}
