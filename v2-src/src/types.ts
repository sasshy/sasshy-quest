export type TaskStatus = 'inbox' | 'planned' | 'active' | 'done' | 'archived';
export type TaskHorizon = 'now' | 'someday' | 'wish' | 'waiting';
export type MorningProgress = 'unrecorded' | 'not_started' | 'partial' | 'completed';

export interface WorkStartDay {
  enabled: boolean;
  anchorText: string;
  currentTargetAt: string;
  reviewOn: string;
  deadlineAt: string;
  remainingEstimateMin: number;
  bufferMin: number;
  latestSafeStartAt: string;
  workStartedAt: string | null;
  firstContactAt: string | null;
  mainStartedAt: string | null;
  mainStartReportedAt: string | null;
  mainSessionId: string | null;
  morningMilestone: string;
  morningProgress: MorningProgress;
  progressRecordedAt: string | null;
  snoozedUntil: string | null;
  skippedAt: string | null;
  notificationEndpointHash: string;
}

export interface WorkStartSupport {
  version: 1;
  days: Record<string, WorkStartDay>;
}

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
  /** Identifies the currently-active placement of this task on the calendar. */
  scheduleVersionId?: string | null;
  /**
   * Whether this task should interrupt the user at its scheduled start.
   * Undefined is kept for pre-setting data so it can be reviewed without
   * silently disabling a possibly important existing notification.
   */
  scheduledStartNotification?: boolean;
  flowOrder?: number;
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
  workStartSupport?: WorkStartSupport;
  sync: SyncMeta;
}

export type SessionStatus = 'running' | 'paused' | 'completed' | 'interrupted';

export interface FocusSession {
  id: string;
  taskId: string;
  taskTitle: string;
  plannedMin: number;
  carriedElapsedSec?: number;
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

export interface TaskUndoAction {
  id: string;
  label: string;
  before: Task | null;
  after: Task | null;
  expectedUpdatedAt: string | null;
  createdAt: string;
  beforeGroup?: Task[];
  afterGroup?: Task[];
  scheduleOperationIds?: string[];
  expectedUpdatedAts?: Record<string, string>;
}

export interface UndoRedoSetting {
  id: 'undo-redo';
  undo: TaskUndoAction[];
  redo: TaskUndoAction[];
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

export type ScheduleOperation =
  | 'schedule'
  | 'reschedule'
  | 'adjust_date'
  | 'adjust_time'
  | 'adjust_duration'
  | 'unschedule'
  | 'set_result'
  | 'correct_result'
  | 'revert'
  | 'reapply'
  | 'resolve_conflict';

export type ScheduleResult =
  | 'unconfirmed'
  | 'completed'
  | 'not_done'
  | 'cancelled'
  | 'skipped';

export interface ScheduleSnapshot {
  scheduleVersionId: string | null;
  scheduledDate: string | null;
  startMinute: number | null;
  durationMin: number;
  title: string;
}

export interface ScheduleHistoryEntry {
  id: string;
  taskId: string;
  operationGroupId: string | null;
  beforeVersionId: string | null;
  afterVersionId: string | null;
  targetVersionId: string | null;
  operation: ScheduleOperation;
  result: ScheduleResult;
  before: ScheduleSnapshot | null;
  after: ScheduleSnapshot | null;
  title: string;
  occurredAt: string;
  serverReceivedAt: string | null;
  deviceId: string;
  source: 'local' | 'remote' | 'external';
  relatedEntryId: string | null;
  reason: string;
}

export interface ScheduleOutboxItem {
  id?: number;
  operationId: string;
  taskId: string;
  baseRevision: string | null;
  taskPayload: Task;
  updateTask: boolean;
  history: ScheduleHistoryEntry;
  createdAt: string;
  attempts: number;
  conflictRevision?: string | null;
  conflictTask?: Task | null;
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
  everyMinute: boolean;
  finalCountdown: boolean;
}

export interface PushConfig {
  id: 'push';
  enabled: boolean;
  endpoint: string;
  deviceName: string;
  lastRegisteredAt: string | null;
  lastTestAt: string | null;
  lastError: string;
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
