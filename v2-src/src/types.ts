export type TaskStatus = 'inbox' | 'planned' | 'active' | 'done' | 'archived';
export type TaskHorizon = 'now' | 'someday' | 'wish' | 'waiting';

export interface SyncMeta {
  serverUpdatedAt?: string;
  deviceId: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  horizon: TaskHorizon;
  scheduledDate: string | null;
  startMinute: number | null;
  durationMin: number;
  estimateMin: number;
  importance: 0 | 1 | 2;
  urgency: 0 | 1 | 2;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  source: 'v2' | 'legacy';
  legacyId?: string;
  sync: SyncMeta;
}

export type SessionStatus = 'running' | 'paused' | 'completed' | 'interrupted';

export interface FocusSession {
  id: string;
  taskId: string;
  taskTitle: string;
  plannedMin: number;
  startedAt: string;
  pausedAt: string | null;
  pausedTotalSec: number;
  endedAt: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  sync: SyncMeta;
}

export interface Memo {
  id: string;
  title: string;
  body: string;
  category: string;
  pinned: boolean;
  reminderAt: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  source: 'v2' | 'legacy';
  legacyId?: string;
  sync: SyncMeta;
}

export interface HistoryEntry {
  id: string;
  entityType: 'task' | 'session' | 'system';
  entityId: string;
  action: string;
  label: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: string;
  source: 'local' | 'remote' | 'import';
}

export interface OutboxItem {
  id?: number;
  entityType: 'task' | 'session' | 'memo';
  entityId: string;
  payload: Task | FocusSession | Memo;
  deleted: boolean;
  createdAt: string;
  attempts: number;
}

export interface SyncConfig {
  id: 'sync';
  enabled: boolean;
  url: string;
  apiKey: string;
  syncKey: string;
  lastSyncAt: string | null;
  lastError: string;
}

export interface VoiceConfig {
  id: 'voice';
  enabled: boolean;
  rate: number;
  volume: number;
  announcements: number[];
}

export interface GoogleCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  calendarName: string;
  color: string;
}

export interface GoogleCalendarConfig {
  id: 'google-calendar';
  enabled: boolean;
  feedUrl: string;
  events: GoogleCalendarEvent[];
  lastSyncAt: string | null;
  lastError: string;
}

export interface AppSetting {
  id: string;
  [key: string]: unknown;
}

export interface CloudRecord {
  record_type: 'task' | 'session' | 'memo';
  id: string;
  payload: Task | FocusSession | Memo;
  deleted: boolean;
  updated_at: string;
}
