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
  dueDate?: string | null;
  dueTime?: string | null;
  counterparty?: string;
  requestSource?: string;
  voiceTranscript?: string;
  reminderEnabled?: boolean;
  reminderAfter?: string | null;
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
  /** A real-world anchor that the automatic runway must never move. */
  isFixed?: boolean;
  flowOrder?: number;
  durationMin: number;
  estimateMin: number;
  /** "ここまでやったら終わり" — decided when starting, shown on the timer. */
  doneWhen?: string;
  /** Set on tasks created by a routine: completing one starts the next step. */
  routine?: { runId: string; name: string; index: number; count: number };
  /** A record of an interruption or a detour (not a planned task; hidden from today's list). */
  log?: 'interrupt' | 'detour';
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
  /** Started with 「2分だけ」: ask at the end whether to keep going. */
  starter?: boolean;
  /** 15-minute round of a longer task. */
  round?: { index: number; total: number; plan: string; result?: 'done' | 'half' | 'not' };
  /** This session is an interruption; where to go back afterwards. */
  interrupt?: { kind: 'interrupt' | 'detour'; returnTaskId: string; returnTitle: string; returnLeftMin: number; returnPlan: string };
  /** Ended by SASSHY because it ran far past the plan (forgotten timer). */
  autoStopped?: boolean;
  /** The user has confirmed how long it really took. */
  reviewed?: boolean;
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
  meal?: MealInfo;
  expense?: ExpenseInfo;
  /** 使う予定のお金 (category 支出予定): subtracted from the budget until spent. */
  planned?: { item: string; amount: number; date?: string | null };
  /** ひとこと日記 (category 日記): one per day. mood 1 (bad) .. 5 (great). */
  diary?: { date: string; mood: number | null };
  /** やりたいこと (category やりたいこと). */
  wish?: WishInfo;
  /** 6つの領域 (category 領域): one per key. */
  area?: AreaInfo;
  /** 習慣 (category 習慣): the days it was done. No streaks, only counts. */
  habit?: HabitInfo;
  sync: SyncMeta;
}

export interface WishInfo {
  status: 'active' | 'resting' | 'done';
  pinned: boolean;
  /** Optional goal for the number of tries (e.g. 映画 5本). */
  target: number | null;
  /** The next small step, written as an action. */
  next: string;
  attempts: { at: string; note: string }[];
}

export interface HabitInfo {
  name: string;
  /** YYYY-MM-DD, sorted */
  days: string[];
  /** When this routine is finished, the day is checked automatically. */
  routineName?: string | null;
}

export type AreaKey = 'money' | 'work' | 'family' | 'health' | 'fun' | 'people';
export interface AreaInfo {
  key: AreaKey;
  state: string;
  next: string;
  /** good / watch (needs attention) / none */
  tone?: 'good' | 'watch' | null;
}

export type MealKind = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** self = paid in full; treated = someone else paid (0); split / paid_for_others use `paid`. */
export type MealPayment = 'self' | 'treated' | 'split' | 'paid_for_others' | 'home';

/** Meal/snack details on a memo with category '食事'. Unknown extra keys from AI imports are kept as-is. */
export interface MealInfo {
  kind: MealKind;
  item: string;
  /** Price of what was eaten (yen); null for home-made. */
  price: number | null;
  priceSource?: 'receipt' | 'estimate';
  /** What actually left the wallet, when different from price. */
  paid?: number | null;
  payment?: MealPayment;
  place?: string | null;
  kcal?: number | null;
  protein?: number | null;
  fat?: number | null;
  carbs?: number | null;
  /** When it was eaten (ISO). */
  at: string;
}

/**
 * A small non-meal spend (taxi, drugstore…) on a memo with category '支出'.
 * ChatGPT may add extra keys (paymentMethod, reimbursementStatus…); they are kept as-is.
 */
export interface ExpenseInfo {
  item: string;
  /** What left the wallet (yen). */
  amount: number;
  /** When it was paid (ISO). */
  at: string;
  category?: string | null;
  [key: string]: unknown;
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
  lastError?: string;
  lastAttemptAt?: string;
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
  workspaceId?: string;
  lastSyncAt: string | null;
  lastError: string;
}

export interface VoiceConfig {
  id: 'voice';
  enabled: boolean;
  coachEnabled?: boolean;
  /** iPhone app: natural AI voice (each sentence made once, about 0.1 yen). */
  aiVoice?: boolean;
  defaultPreparationMin?: number;
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
