import Dexie, { type EntityTable } from 'dexie';
import type { AppSetting, FocusSession, GoogleCalendarConfig, GoogleCalendarEvent, HistoryEntry, Memo, OutboxItem, Task } from './types';

export class SasshyDatabase extends Dexie {
  tasks!: EntityTable<Task, 'id'>;
  sessions!: EntityTable<FocusSession, 'id'>;
  memos!: EntityTable<Memo, 'id'>;
  history!: EntityTable<HistoryEntry, 'id'>;
  outbox!: EntityTable<OutboxItem, 'id'>;
  settings!: EntityTable<AppSetting, 'id'>;

  constructor(name = 'sasshy-v2') {
    super(name);
    this.version(1).stores({
      tasks: 'id, status, horizon, scheduledDate, updatedAt, deletedAt',
      sessions: 'id, taskId, status, startedAt, updatedAt, deletedAt',
      memos: 'id, category, pinned, reminderAt, updatedAt, deletedAt',
      history: 'id, entityType, entityId, createdAt, source',
      outbox: '++id, [entityType+entityId], createdAt',
      settings: 'id',
    });
  }
}

export const db = new SasshyDatabase();

export function makeId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getDeviceId(): Promise<string> {
  const existing = await db.settings.get('device');
  if (existing && typeof existing.value === 'string') return existing.value;
  const value = makeId('device');
  await db.settings.put({ id: 'device', value });
  return value;
}

export async function ensureDefaults(): Promise<void> {
  const [sync, voice, googleCalendar] = await Promise.all([db.settings.get('sync'), db.settings.get('voice'), db.settings.get('google-calendar')]);
  if (!sync) {
    let old: Partial<{ url: string; anonKey: string; syncKey: string }> = {};
    try {
      old = JSON.parse(localStorage.getItem('sasshy_quest_supabase_sync_v1') || '{}');
    } catch {
      old = {};
    }
    await db.settings.put({
      id: 'sync',
      enabled: false,
      url: old.url || '',
      apiKey: old.anonKey || '',
      syncKey: old.syncKey ? `${old.syncKey}-v2` : '',
      lastSyncAt: null,
      lastError: '',
    });
  }
  if (!voice) {
    await db.settings.put({
      id: 'voice',
      enabled: true,
      rate: 1,
      volume: 1,
      announcements: [30, 15, 10, 5, 3, 1],
    });
  }
  if (!googleCalendar) {
    let old: { feedUrl?: string; events?: Array<Record<string, unknown>>; lastSync?: number; lastError?: string } = {};
    try {
      const state = JSON.parse(localStorage.getItem('sasshy_quest_v5') || '{}') as { gcal?: typeof old };
      old = state.gcal || {};
    } catch {
      old = {};
    }
    const events: GoogleCalendarEvent[] = (old.events || []).flatMap((event, index) => {
      const date = typeof event.date === 'string' ? event.date : '';
      if (!date) return [];
      const allDay = Boolean(event.allDay) || !event.startTime;
      const start = allDay ? date : `${date}T${String(event.startTime).slice(0, 5)}:00`;
      const end = allDay ? null : `${date}T${String(event.endTime || event.startTime).slice(0, 5)}:00`;
      return [{
        id: String(event.id || `legacy-google-${index}`),
        title: String(event.title || '(無題)'),
        start,
        end,
        allDay,
        calendarName: String(event.calendarName || ''),
        color: String(event.calendarColor || ''),
      }];
    });
    const initial: GoogleCalendarConfig = {
      id: 'google-calendar',
      enabled: Boolean(old.feedUrl),
      feedUrl: old.feedUrl || '',
      events,
      lastSyncAt: old.lastSync ? new Date(old.lastSync).toISOString() : null,
      lastError: old.lastError || '',
    };
    await db.settings.put(initial as unknown as AppSetting);
  }
  await getDeviceId();
}
