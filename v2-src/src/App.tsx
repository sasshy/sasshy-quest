import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin, { Draggable } from "@fullcalendar/interaction";
import type { DateClickArg, EventDragStopArg } from "@fullcalendar/interaction";
import type {
  DatesSetArg,
  EventClickArg,
  EventDropArg,
  EventInput,
} from "@fullcalendar/core";
import jaLocale from "@fullcalendar/core/locales/ja";
import {
  Archive,
  Bell,
  CalendarDays,
  Check,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  Cloud,
  CloudOff,
  Download,
  History,
  Inbox,
  ListTodo,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  GripVertical,
  GripHorizontal,
  Lock,
  Maximize2,
  Pause,
  Pencil,
  CalendarX,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Map as MapIcon,
  Square,
  TimerReset,
  Trash2,
  Upload,
  Volume2,
  X,
  Undo2,
  Mic,
} from "lucide-react";
import { db } from "./db";
import { createBackup, downloadBackup } from "./backup";
import {
  compactDate,
  completeTask,
  completeTaskFromActual,
  createManualFocusSession,
  createMemo,
  createTask,
  restoreHistoryEntry,
  getUndoRedoState,
  pauseFocusSession,
  recordExistingMainWork,
  redoLatestTaskChange,
  reorderTasksForDay,
  setTasksFlowOrder,
  restoreTask,
  resumeFocusSession,
  restartFocusSession,
  discardFocusSession,
  stopFocusSessionAt,
  setFocusSessionPlannedMinutes,
  softDeleteSession,
  softDeleteTask,
  startFocusSession,
  taskStart,
  todayKey,
  undoLatestTaskChange,
  updateMemo,
  updateSession,
  updateTask,
} from "./store";
import { WorkStartPanel } from "./WorkStartPanel";
import { CalendarDayDetail } from "./CalendarDayDetail";
import {
  ScheduleEditorSheet,
  type ScheduleDraftSeed,
} from "./ScheduleEditorSheet";
import { ScheduleHistoryPanel } from "./ScheduleHistoryPanel";
import {
  latestResultsByVersion,
  scheduleResultLabel,
} from "./schedule-history";
import {
  getSyncConfig,
  getSyncState,
  saveSyncConfig,
  setInteractionActive,
  startAutoSync,
  subscribeSync,
  syncNow,
  testSyncConnection,
  type SyncState,
} from "./sync";
import { importLegacy, legacySummary, type LegacySummary } from "./legacy";
import {
  emptyGoogleCalendar,
  getGoogleCalendarConfig,
  refreshGoogleCalendar,
  saveGoogleCalendarConfig,
} from "./google-calendar";
import type {
  FocusSession,
  GoogleCalendarConfig,
  HistoryEntry,
  Memo,
  PushConfig,
  ScheduleHistoryEntry,
  ScheduleOutboxItem,
  SyncConfig,
  Task,
  TaskHorizon,
  VoiceConfig,
} from "./types";
import {
  announcementText,
  announcementThresholds,
  remainingStatusText,
  speakVoice,
  stopVoice,
  overtimeReminderStep,
} from "./voice";
import { buildDayRunway, type RunwayEntry } from "./day-runway";
import {
  predictDuration,
  sessionDuration,
  taskActualDuration,
  taskWorkedSeconds,
  usualMinutes,
} from "./insights";
import {
  disablePushNotifications,
  enablePushNotifications,
  getPushConfig,
  getPushSupport,
  testPushNotification,
} from "./push";
import {
  clearTaskLinkFromUrl,
  parseTaskLink,
  type ParsedTaskLink,
} from "./task-link";
import { buildCoachPlan, completionCoachText } from "./coach";
import { OpenCountPanel } from "./MealPanel";
import { LeaveBanner, RoutineBar } from "./RoutinePanel";
import { RecordsPanel } from "./RecordsPanel";
import { MobilePlanner } from "./MobilePlanner";
import { DayCompare } from "./DayCompare";
import { TimeGrid, threeDays } from "./TimeGrid";
import { MonthGrid } from "./MonthGrid";
import { BudgetCard } from "./BudgetPanel";
import { announceCompletion } from "./progress";
import { restoreBudgetCardOnce } from "./budget";
import { AppearancePanel } from "./AppearancePanel";
import { Celebrate } from "./Celebrate";
import { TodayProgress } from "./TodayProgress";
import { CompanionPopup, companionStart } from "./Companion";
import { AgeLabel, TimeLeftStrip } from "./TimeLeftPanel";
import { LifeMapPanel } from "./LifeMapPanel";
import { isAreaMemo, isWishMemo } from "./wishes";
import { checkHabitForTask, checkRoutineHabit, isHabitMemo } from "./habits";
import { TwoMinutePrompt, starterPlannedMin } from "./TwoMinute";
import { StaleSessionPrompt, isStale } from "./StaleSession";
import { canListen, listenOnce, parseVoiceCommand } from "./voice-command";
import { RoundBar, RoundBreakBanner, RoundEndPrompt, returnFromInterrupt, type StartOptions } from "./RoundPanel";
import { nextRound, planSuggestions, usesRounds } from "./rounds";
import { haptic, playStart } from "./feedback";
import { nextRoutineTask } from "./routines";
import { isLedgerMemo } from "./meals";
import { isDiaryMemo } from "./diary";
import { QuickRecord } from "./QuickRecord";
import { syncNativeCoach } from "./native-alarm";
import baseSetupSql from "../supabase-setup.sql?raw";
import calendarHistorySql from "../supabase-calendar-history.sql?raw";

import credentialSetupSql from "../supabase/migrations/20260912150411_separate_workspace_credentials.sql?raw";

const setupSql = `${baseSetupSql}\n\n${calendarHistorySql}\n\n${credentialSetupSql}`;

type Page =
  | "today"
  | "calendar"
  | "map"
  | "records"
  | "inbox"
  | "later"
  | "memos"
  | "history"
  | "settings";
type CalendarMode = "list" | "day" | "three" | "week" | "month";

function formatCalendarTitle(info: DatesSetArg): string {
  const current = info.view.calendar.getDate();
  if (info.view.type === "timeGridDay") {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(current);
  }
  if (info.view.type === "dayGridMonth") {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "long",
    }).format(current);
  }

  const start = info.view.currentStart;
  const end = new Date(info.view.currentEnd);
  end.setDate(end.getDate() - 1);
  const startLabel = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(start);
  const endLabel =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth()
      ? `${end.getDate()}日`
      : new Intl.DateTimeFormat("ja-JP", {
          year: "numeric",
          month: "numeric",
          day: "numeric",
        }).format(end);
  return `${startLabel} – ${endLabel}`;
}

const PAGE_LABEL: Record<Page, string> = {
  today: "今日",
  calendar: "カレンダー",
  map: "地図",
  records: "記録",
  inbox: "やること",
  later: "あとで",
  memos: "メモ",
  history: "復元",
  settings: "設定",
};

function useMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return mobile;
}

function formatMinute(value: number | null): string {
  if (value === null) return "";
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function parseMinute(value: string): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function formatDateLabel(value: string | null): string {
  if (!value) return "日付なし";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(year, month - 1, day));
}

function shiftDate(value: string | null, amount: number): string {
  const base = value || todayKey();
  const [year, month, day] = base.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return compactDate(date);
}

function formatStamp(value: string | null): string {
  if (!value) return "まだ同期していません";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toLocalDateTimeInput(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function actualMinutesBetween(start: string, end: string): number | null {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    return null;
  return Math.max(1, Math.round((endMs - startMs) / 60_000));
}

function taskScore(task: Task): number {
  const overdue = task.scheduledDate && task.scheduledDate < todayKey() ? 8 : 0;
  return task.importance * 3 + task.urgency * 4 + overdue;
}

function compareDayFlowTasks(a: Task, b: Task): number {
  if (a.flowOrder !== undefined || b.flowOrder !== undefined) {
    if (a.flowOrder === undefined) return 1;
    if (b.flowOrder === undefined) return -1;
    if (a.flowOrder !== b.flowOrder) return a.flowOrder - b.flowOrder;
  }
  return (
    (a.startMinute ?? 9999) - (b.startMinute ?? 9999) ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

function IconButton({
  label,
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button${danger ? " danger" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Check size={22} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function QuickAdd({
  defaultDate,
  onAdded,
}: {
  defaultDate?: string | null;
  onAdded?: (task: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const task = await createTask({
        title,
        scheduledDate: defaultDate || null,
      });
      haptic("tap");
      setTitle("");
      onAdded?.(task);
      syncNow().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="quick-add" onSubmit={submit}>
      <Plus size={20} aria-hidden="true" />
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={
          defaultDate
            ? `${formatDateLabel(defaultDate)}にタスクを追加`
            : "思いついたことをそのまま入力"
        }
        aria-label="新しいタスク"
      />
      <button type="submit" disabled={!title.trim() || busy}>
        追加
      </button>
    </form>
  );
}

function TaskLinkImportDialog({
  task,
  onClose,
  onAdded,
}: {
  task: ParsedTaskLink;
  onClose: () => void;
  onAdded: (created: Task, duplicate: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const receiptId = `task-link:${task.requestId}`;
      const receipt = await db.settings.get(receiptId);
      const taskId = typeof receipt?.taskId === "string" ? receipt.taskId : "";
      const existing = taskId ? await db.tasks.get(taskId) : undefined;
      if (existing) {
        onAdded(existing, true);
        return;
      }
      const created = await createTask({
        title: task.title,
        notes: task.notes,
        scheduledDate: task.scheduledDate,
        startMinute: task.startMinute,
        durationMin: task.durationMin,
        estimateMin: task.durationMin,
        importance: task.importance,
        urgency: task.urgency,
        horizon: task.horizon,
        legacyId: `codex:${task.requestId}`,
      }, "import");
      await db.settings.put({
        id: receiptId,
        taskId: created.id,
        importedAt: new Date().toISOString(),
      });
      syncNow().catch(() => undefined);
      onAdded(created, false);
    } catch {
      setError("タスクを追加できませんでした。もう一度お試しください");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="modal-sheet task-link-dialog" role="dialog" aria-modal="true" aria-labelledby="task-link-title">
        <header>
          <div>
            <span className="eyebrow">CODEXから受信</span>
            <h2 id="task-link-title">このタスクを追加しますか？</h2>
          </div>
          <IconButton label="閉じる" onClick={onClose}><X size={19} /></IconButton>
        </header>
        <div className="task-link-summary">
          <strong>{task.title}</strong>
          {task.notes && <p>{task.notes}</p>}
          <dl>
            <div><dt>予定</dt><dd>{task.scheduledDate ? formatDateLabel(task.scheduledDate) : "日付なし"}{task.startMinute !== null ? ` ${formatMinute(task.startMinute)}` : ""}</dd></div>
            <div><dt>所要時間</dt><dd>{task.durationMin}分</dd></div>
          </dl>
          {error && <p className="settings-error">{error}</p>}
        </div>
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="button primary" type="button" onClick={add} disabled={busy}>{busy ? "追加中…" : "SASSHYに追加"}</button>
        </footer>
      </section>
    </div>
  );
}

function PriorityMarks({ task }: { task: Task }) {
  if (!task.importance && !task.urgency) return null;
  return (
    <span className="priority-marks">
      {task.importance > 0 && <span className="mark important">重要</span>}
      {task.urgency > 0 && <span className="mark urgent">緊急</span>}
    </span>
  );
}

function SwipeableTask({
  task,
  children,
}: {
  task: Task;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const gesture = useRef<{
    startX: number;
    startY: number;
    initialOffset: number;
    horizontal: boolean;
    moved: boolean;
  } | null>(null);
  const setSwipeOffset = (value: number) => {
    const clamped = Math.max(-88, Math.min(0, value));
    offsetRef.current = clamped;
    setOffset(clamped);
  };
  const finishSwipe = () => {
    const current = gesture.current;
    if (!current) return;
    const shouldOpen = current.horizontal && offsetRef.current < -38;
    setSwipeOffset(shouldOpen ? -82 : 0);
    window.setTimeout(() => {
      gesture.current = null;
    }, 0);
  };
  return (
    <div className={`task-swipe-shell${offset < 0 ? " open" : ""}`}>
      <button
        className="task-swipe-delete"
        type="button"
        aria-label={`${task.title}を削除`}
        onClick={async () => {
          await softDeleteTask(task.id);
          syncNow().catch(() => undefined);
        }}
      >
        <Trash2 size={18} />
        削除
      </button>
      <div
        className="task-swipe-surface"
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={(event) => {
          gesture.current = {
            startX: event.clientX,
            startY: event.clientY,
            initialOffset: offsetRef.current,
            horizontal: false,
            moved: false,
          };
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current) return;
          const dx = event.clientX - current.startX;
          const dy = event.clientY - current.startY;
          if (!current.horizontal) {
            if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
            current.horizontal = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          current.moved = current.moved || Math.abs(dx) > 10;
          setSwipeOffset(current.initialOffset + dx);
        }}
        onPointerUp={finishSwipe}
        onPointerCancel={finishSwipe}
        onClickCapture={(event) => {
          const current = gesture.current;
          if (current?.moved || offsetRef.current < 0) {
            event.preventDefault();
            event.stopPropagation();
            if (!current?.moved) setSwipeOffset(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onEdit,
  onStart,
  compact = false,
  actualMin,
  actualReliable = true,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
  compact?: boolean;
  actualMin?: number;
  actualReliable?: boolean;
}) {
  const done = task.status === "done";
  const delta = actualMin === undefined ? null : actualMin - task.estimateMin;
  return (
    <SwipeableTask task={task}>
      <div
        className={`task-row${done ? " done" : ""}${compact ? " compact" : ""}`}
      >
      <button
        className="task-check"
        type="button"
        aria-label={done ? "完了を取り消す" : "完了"}
        onClick={() =>
          completeTask(task.id, !done).then(() => {
            if (!done) announceCompletion().catch(() => undefined);
            syncNow().catch(() => undefined);
          })
        }
      >
        {done && <Check size={16} />}
      </button>
      <button className="task-main" type="button" onClick={() => onEdit(task)}>
        <strong>{task.title}</strong>
        <span className="task-meta">
          {task.scheduledDate && (
            <span>{formatDateLabel(task.scheduledDate)}</span>
          )}
          {task.startMinute !== null && (
            <span>{formatMinute(task.startMinute)}</span>
          )}
          {task.dueDate && <span>期限 {task.dueDate} {task.dueTime || ""}</span>}
          {task.counterparty && <span>{task.counterparty}</span>}
          {task.reminderEnabled && !done && <span>再通知ON</span>}
          <span>予測 {task.estimateMin}分</span>
          {actualMin !== undefined && (
            <span className={`actual-chip${actualReliable ? "" : " suspect"}`}>
              実績 {actualMin}分
              {delta ? `（${delta > 0 ? "+" : ""}${delta}分）` : ""}
              {actualReliable ? "" : "・要確認"}
            </span>
          )}
          <PriorityMarks task={task} />
        </span>
      </button>
      {done ? (
        <button
          className="task-reopen-action"
          type="button"
          onClick={() =>
            completeTask(task.id, false).then(() =>
              syncNow().catch(() => undefined),
            )
          }
        >
          <RotateCcw size={15} />
          完了取消
        </button>
      ) : (
        <IconButton label="音声タイマーを開始" onClick={() => onStart(task)}>
          <Play size={18} />
        </IconButton>
      )}
      <IconButton label="編集" onClick={() => onEdit(task)}>
        <Pencil size={17} />
      </IconButton>
      </div>
    </SwipeableTask>
  );
}

function defaultActualRange(task: Task): { start: string; end: string } {
  let end = new Date();
  let start = new Date(end.getTime() - task.estimateMin * 60_000);
  if (task.scheduledDate && task.startMinute !== null) {
    const [year, month, day] = task.scheduledDate.split("-").map(Number);
    start = new Date(
      year,
      month - 1,
      day,
      Math.floor(task.startMinute / 60),
      task.startMinute % 60,
    );
    end = new Date(start.getTime() + task.estimateMin * 60_000);
  }
  return { start: toLocalDateTimeInput(start), end: toLocalDateTimeInput(end) };
}

function WorkLogRow({ session, markDone }: { session: FocusSession; markDone: boolean }) {
  const [start, setStart] = useState(toLocalDateTimeInput(session.startedAt));
  const [end, setEnd] = useState(
    toLocalDateTimeInput(session.endedAt || new Date()),
  );
  const [message, setMessage] = useState("");
  useEffect(() => {
    setStart(toLocalDateTimeInput(session.startedAt));
    setEnd(toLocalDateTimeInput(session.endedAt || new Date()));
  }, [session.startedAt, session.endedAt, session.updatedAt]);
  const actualMin = actualMinutesBetween(start, end);
  const save = async () => {
    if (!actualMin) {
      setMessage("終了時刻は開始時刻より後にしてください");
      return;
    }
    const endedAt = new Date(end).toISOString();
    await updateSession(
      session.id,
      {
        startedAt: new Date(start).toISOString(),
        endedAt,
        pausedAt: null,
        pausedTotalSec: 0,
        ...(markDone ? { status: "completed" as const } : {}),
      },
      "作業実績の時刻を修正",
    );
    if (markDone) await completeTaskFromActual(session.taskId, endedAt, session.id);
    setMessage(markDone ? "実績を更新して、完了にしました" : "実績を更新しました");
    syncNow().catch(() => undefined);
  };
  return (
    <div className="work-log-row">
      <div className="work-log-inputs">
        <label>
          <span>開始</span>
          <input
            type="datetime-local"
            value={start}
            onChange={(event) => setStart(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>終了</span>
          <input
            type="datetime-local"
            value={end}
            onChange={(event) => setEnd(event.currentTarget.value)}
          />
        </label>
      </div>
      <div className="work-log-actions">
        <span>
          {actualMin ? `実績 ${actualMin}分` : "時刻を確認してください"}
        </span>
        <button className="button secondary" type="button" onClick={save}>
          時刻を更新
        </button>
        <IconButton
          label="この実績を削除"
          danger
          onClick={() =>
            softDeleteSession(session.id).then(() =>
              syncNow().catch(() => undefined),
            )
          }
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
      {message && <small>{message}</small>}
    </div>
  );
}

function TaskEditor({
  task,
  sessions,
  scheduleHistory,
  scheduleConflicts,
  onClose,
  onStart,
}: {
  task: Task;
  sessions: FocusSession[];
  scheduleHistory: ScheduleHistoryEntry[];
  scheduleConflicts: ScheduleOutboxItem[];
  onClose: () => void;
  onStart: (task: Task) => void;
}) {
  const [draft, setDraft] = useState(task);
  const [saving, setSaving] = useState(false);
  const [addingActual, setAddingActual] = useState(false);
  const [actualRange, setActualRange] = useState(() =>
    defaultActualRange(task),
  );
  const [actualMessage, setActualMessage] = useState("");
  const prediction = useMemo(
    () => predictDuration(draft.title, sessions, task.id),
    [draft.title, sessions, task.id],
  );
  const actual = useMemo(
    () => taskActualDuration(task.id, sessions),
    [task.id, sessions],
  );
  const taskSessions = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            session.taskId === task.id &&
            !session.deletedAt &&
            session.endedAt &&
            (session.status === "completed" ||
              session.status === "interrupted"),
        )
        .sort((a, b) => (b.endedAt || "").localeCompare(a.endedAt || "")),
    [sessions, task.id],
  );
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateTask(
        task.id,
        {
          title: draft.title.trim() || task.title,
          notes: draft.notes,
          dueDate: draft.dueDate || null,
          dueTime: draft.dueDate ? draft.dueTime || null : null,
          counterparty: draft.counterparty || '',
          requestSource: draft.requestSource || '',
          reminderEnabled: Boolean(draft.reminderEnabled),
          reminderAfter: draft.reminderAfter || null,
          horizon: draft.horizon,
          scheduledDate: draft.scheduledDate,
          startMinute: draft.startMinute,
          scheduledStartNotification: draft.scheduledStartNotification,
          isFixed: Boolean(draft.startMinute !== null && draft.isFixed !== false),
          estimateMin: Math.max(1, Number(draft.estimateMin) || 5),
          durationMin: Math.max(
            1,
            Number(draft.durationMin) || Number(draft.estimateMin) || 5,
          ),
          importance: draft.importance,
          urgency: draft.urgency,
        },
        "タスク詳細を更新",
      );
      onClose();
      syncNow().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };
  const [actualDone, setActualDone] = useState(task.status !== "done");
  const addActual = async () => {
    const minutes = actualMinutesBetween(actualRange.start, actualRange.end);
    if (!minutes) {
      setActualMessage("終了時刻は開始時刻より後にしてください");
      return;
    }
    try {
      const added = await createManualFocusSession(task, actualRange.start, actualRange.end);
      if (actualDone) {
        await completeTaskFromActual(task.id, added.endedAt!, added.id);
        syncNow().catch(() => undefined);
        onClose();
        return;
      }
      setActualMessage(`${minutes}分の実績を追加しました`);
      setAddingActual(false);
      setActualRange(defaultActualRange(task));
      syncNow().catch(() => undefined);
    } catch (error) {
      setActualMessage(
        error instanceof Error ? error.message : "実績を追加できませんでした",
      );
    }
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-edit-title"
      >
        <header>
          <div>
            <span className="eyebrow">TASK</span>
            <h2 id="task-edit-title">タスクを編集</h2>
          </div>
          <IconButton label="閉じる" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        <div className="form-stack">
          <label>
            <span>タイトル</span>
            <input
              value={draft.title}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, title: value }));
              }}
            />
          </label>
          <label>
            <span>メモ</span>
            <textarea
              value={draft.notes}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, notes: value }));
              }}
              rows={4}
            />
          </label>
          <details className="work-task-fields" open={Boolean(draft.voiceTranscript || draft.reminderEnabled || draft.dueDate)}>
            <summary>仕事の期限・相手・再通知</summary>
            <div className="form-stack">
              <div className="form-grid">
                <label><span>期限日</span><input type="date" value={draft.dueDate || ""} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, dueDate: value || null, dueTime: value ? current.dueTime : null })); }} /></label>
                <label><span>期限時刻（日本時間）</span><input type="time" disabled={!draft.dueDate} value={draft.dueTime || ""} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, dueTime: value || null })); }} /></label>
                <label><span>相手</span><input maxLength={200} value={draft.counterparty || ""} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, counterparty: value })); }} /></label>
                <label><span>依頼元</span><input maxLength={200} placeholder="例：善之さん／電話" value={draft.requestSource || ""} onChange={event => { const value = event.currentTarget.value; setDraft(current => ({ ...current, requestSource: value })); }} /></label>
              </div>
              <label className="checkbox-row"><input type="checkbox" checked={Boolean(draft.reminderEnabled)} onChange={event => { const value = event.currentTarget.checked; setDraft(current => ({ ...current, reminderEnabled: value })); }} /><span>未対応なら再通知</span></label>
              {draft.reminderEnabled && <>
                <p className="muted">平日9〜18時（日本時間）に1時間おき。期限の時刻から、時刻なしは17時から、期限なしは登録1時間後から通知します。作業開始・完了・ゴミ箱移動で停止します。先7日・最大48件をiPhoneに予約し、アプリを開くと補充します。他端末の変更はこのアプリの同期後に反映します。</p>
                <p className="muted">延期：{draft.reminderAfter ? new Date(draft.reminderAfter).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + "まで" : "なし"}</p>
                <div className="button-row"><button className="button" type="button" onClick={() => setDraft(current => ({ ...current, reminderAfter: new Date(Date.now() + 3_600_000).toISOString() }))}>今から1時間延期</button><button className="button" type="button" onClick={() => setDraft(current => ({ ...current, reminderAfter: new Date(Date.now() + 86_400_000).toISOString() }))}>今から1日延期</button><button className="button" type="button" onClick={() => setDraft(current => ({ ...current, reminderAfter: null }))}>延期を解除</button></div>
              </>}
              {draft.voiceTranscript && <details><summary>元の音声メモ</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draft.voiceTranscript}</p></details>}
            </div>
          </details>
          <div className="form-grid">
            <div className="task-date-editor">
              <label>
                <span>日付</span>
                <input
                  type="date"
                  aria-label="日付"
                  value={draft.scheduledDate || ""}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({
                      ...current,
                      scheduledDate: value || null,
                    }));
                  }}
                />
              </label>
              <div
                className="date-shortcuts"
                role="group"
                aria-label="日付の簡単変更"
              >
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      scheduledDate: shiftDate(current.scheduledDate, -1),
                    }))
                  }
                >
                  前日
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      scheduledDate: todayKey(),
                    }))
                  }
                >
                  今日
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      scheduledDate: shiftDate(current.scheduledDate, 1),
                    }))
                  }
                >
                  翌日
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      scheduledDate: null,
                      startMinute: null,
                      isFixed: false,
                    }))
                  }
                >
                  日付なし
                </button>
              </div>
              <small>
                {draft.scheduledDate
                  ? `選択中：${formatDateLabel(draft.scheduledDate)}`
                  : "選択中：日付なし"}
              </small>
            </div>
            <label>
              <span>開始時刻</span>
              <input
                type="time"
                value={formatMinute(draft.startMinute)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({
                    ...current,
                    startMinute: parseMinute(value),
                    isFixed: value ? current.isFixed !== false : false,
                  }));
                }}
              />
            </label>
            <label className="task-notification-choice">
              <span>予定開始の通知</span>
              <select
                aria-label="予定開始の通知"
                disabled={!draft.scheduledDate || draft.startMinute === null}
                value={draft.scheduledStartNotification === undefined
                  ? "legacy"
                  : draft.scheduledStartNotification
                    ? "on"
                    : "off"}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({
                    ...current,
                    scheduledStartNotification: value === "legacy" ? undefined : value === "on",
                  }));
                }}
              >
                {draft.scheduledStartNotification === undefined && (
                  <option value="legacy">要確認（旧設定を一時継続）</option>
                )}
                <option value="off">OFF（通知しない）</option>
                <option value="on">ON（開始時刻に1回）</option>
              </select>
              <small>
                {draft.scheduledStartNotification === undefined
                  && draft.scheduledDate
                  && draft.startMinute !== null
                  ? "必要ならON、不要ならOFFを選んで保存してください"
                  : "このタスクだけの通知設定です"}
              </small>
            </label>
            {draft.startMinute !== null && (
              <label className="fixed-time-toggle">
                <input
                  type="checkbox"
                  checked={draft.isFixed !== false}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setDraft((current) => ({ ...current, isFixed: checked }));
                  }}
                />
                <span>
                  <Lock size={14} />
                  この時刻は固定（自動でずらさない）
                </span>
              </label>
            )}
            <label>
              <span>予定時間</span>
              <input
                type="number"
                min="1"
                step="1"
                value={draft.estimateMin}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  setDraft((current) => ({ ...current, estimateMin: value }));
                }}
              />
            </label>
            <label>
              <span>置き場所</span>
              <select
                value={draft.horizon}
                onChange={(event) => {
                  const value = event.currentTarget.value as TaskHorizon;
                  setDraft((current) => ({ ...current, horizon: value }));
                }}
              >
                <option value="now">今やる</option>
                <option value="someday">いつか</option>
                <option value="wish">やりたい</option>
                <option value="waiting">待ち</option>
              </select>
            </label>
            <label>
              <span>重要度</span>
              <select
                value={draft.importance}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value) as 0 | 1 | 2;
                  setDraft((current) => ({ ...current, importance: value }));
                }}
              >
                <option value="0">指定なし</option>
                <option value="1">重要</option>
                <option value="2">最重要</option>
              </select>
            </label>
            <label>
              <span>緊急度</span>
              <select
                value={draft.urgency}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value) as 0 | 1 | 2;
                  setDraft((current) => ({ ...current, urgency: value }));
                }}
              >
                <option value="0">指定なし</option>
                <option value="1">緊急</option>
                <option value="2">最緊急</option>
              </select>
            </label>
          </div>
          {(actual || prediction) && (
            <div className="duration-insight">
              <div>
                {actual && (
                  <strong>
                    今回の実績 {actual.activeMin}分
                    {actual.reliable
                      ? ""
                      : "（押し忘れの可能性・予測から除外）"}
                  </strong>
                )}
                {prediction && (
                  <span>
                    次回予測 {prediction.predictedMin}分・
                    {prediction.sampleSize
                      ? `過去${prediction.sampleSize}回の中央値`
                      : "短い生活タスクの目安"}
                    {prediction.ignoredCount
                      ? `（長すぎる記録${prediction.ignoredCount}件を除外）`
                      : ""}
                  </span>
                )}
              </div>
              {prediction && prediction.predictedMin !== draft.estimateMin && (
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      estimateMin: prediction.predictedMin,
                      durationMin: prediction.predictedMin,
                    }))
                  }
                >
                  予測を使う
                </button>
              )}
            </div>
          )}
          <ScheduleHistoryPanel
            task={task}
            entries={scheduleHistory}
            conflicts={scheduleConflicts}
            onChanged={onClose}
          />
          <section className="work-log-section">
            <header>
              <div>
                <strong>実際に作業した時間</strong>
                <span>開始を押し忘れた時も、ここから後で記録できます。</span>
              </div>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setAddingActual((value) => !value);
                  setActualMessage("");
                }}
              >
                <Plus size={16} />
                実績を後から追加
              </button>
            </header>
            {addingActual && (
              <div className="work-log-add">
                <div className="work-log-inputs">
                  <label>
                    <span>開始</span>
                    <input
                      type="datetime-local"
                      value={actualRange.start}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setActualRange((current) => ({
                          ...current,
                          start: value,
                        }));
                      }}
                    />
                  </label>
                  <label>
                    <span>終了</span>
                    <input
                      type="datetime-local"
                      value={actualRange.end}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setActualRange((current) => ({
                          ...current,
                          end: value,
                        }));
                      }}
                    />
                  </label>
                </div>
                <button
                  className="button primary"
                  type="button"
                  onClick={addActual}
                >
                  この実績を追加
                </button>
              </div>
            )}
            {task.status !== "done" && (
              <label className="work-log-done">
                <input type="checkbox" checked={actualDone} onChange={(event) => setActualDone(event.currentTarget.checked)} />
                <span>時刻を入れたら、その時間にやり終えたことにして完了にする</span>
              </label>
            )}
            {actualMessage && (
              <p className="work-log-message">{actualMessage}</p>
            )}
            {taskSessions.length > 0 && (
              <div className="work-log-list">
                {taskSessions.map((session) => (
                  <WorkLogRow key={session.id} session={session} markDone={actualDone} />
                ))}
              </div>
            )}
          </section>
        </div>
        <footer className="modal-actions">
          <button
            className="button danger-quiet"
            type="button"
            disabled={saving}
            onClick={async () => {
              await softDeleteTask(task.id);
              onClose();
              syncNow().catch(() => undefined);
            }}
          >
            <Trash2 size={17} />
            ゴミ箱へ
          </button>
          {task.status === "done" && (
            <button
              className="button secondary"
              type="button"
              disabled={saving}
              onClick={async () => {
                await completeTask(task.id, false);
                onClose();
                syncNow().catch(() => undefined);
              }}
            >
              <RotateCcw size={16} />
              完了取消
            </button>
          )}
          <span className="spacer" />
          {task.status !== "done" && (
            <button
              className="button secondary"
              type="button"
              disabled={saving}
              onClick={() => {
                onClose();
                onStart(draft);
              }}
            >
              <Play size={17} />
              タイマー
            </button>
          )}
          <button
            className="button primary"
            type="button"
            disabled={saving}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function TodayPage({
  tasks,
  sessions,
  syncState,
  onEdit,
  onStart,
}: {
  tasks: Task[];
  sessions: FocusSession[];
  syncState: SyncState;
  onEdit: (task: Task) => void;
  onStart: (task: Task, opts?: { starter?: boolean }) => Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [runwayOpen, setRunwayOpen] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = todayKey();
  const dayTasks = tasks
    .filter(
      (task) =>
        !task.deletedAt &&
        !task.log &&
        task.scheduledDate === today,
    )
    .sort((a, b) =>
      Number(a.status === "done") - Number(b.status === "done") ||
      compareDayFlowTasks(a, b),
    );
  const due = dayTasks.filter((task) => task.status !== "done");
  const fixedTasks = due.filter(
    (task) => task.startMinute !== null && task.isFixed !== false,
  );
  const flexibleTasks = due.filter(
    (task) => task.startMinute === null || task.isFixed === false,
  );
  const reorderFlexibleTasks = async (ids: string[]) => {
    await setTasksFlowOrder(ids);
    syncNow().catch(() => undefined);
  };
  const googleCalendar =
    useLiveQuery(() => getGoogleCalendarConfig(), [], emptyGoogleCalendar) ||
    emptyGoogleCalendar;
  const calendarAnchors = googleCalendar.enabled
    ? googleCalendar.events
        .filter((event) => !event.allDay && compactDate(new Date(event.start)) === today)
        .map((event) => {
          const start = new Date(event.start);
          const end = event.end ? new Date(event.end) : null;
          return {
            id: `google:${event.id}`,
            title: event.title,
            durationMin: Math.max(
              1,
              end && Number.isFinite(end.getTime())
                ? Math.round((end.getTime() - start.getTime()) / 60_000)
                : 30,
            ),
            fixed: true,
            startMinute: start.getHours() * 60 + start.getMinutes(),
            kind: "calendar" as const,
          };
        })
    : [];
  const current = new Date(now);
  const nowMinute = current.getHours() * 60 + current.getMinutes();
  const runway = buildDayRunway(
    [
      ...flexibleTasks.map((task) => ({
        id: task.id,
        title: task.title,
        durationMin: task.estimateMin,
        fixed: false,
        startMinute: null,
        kind: "task" as const,
      })),
      ...fixedTasks.map((task) => ({
        id: task.id,
        title: task.title,
        durationMin: task.estimateMin,
        fixed: true,
        startMinute: task.startMinute,
        kind: "task" as const,
      })),
      ...calendarAnchors,
    ],
    { nowMinute, dayEndMinute: 22 * 60, preparationMin: 10 },
  );
  const overdue = tasks
    .filter(
      (task) =>
        !task.deletedAt &&
        !task.log &&
        task.status !== "done" &&
        task.scheduledDate &&
        task.scheduledDate < today,
    )
    .sort((a, b) => taskScore(b) - taskScore(a));
  const inbox = tasks
    .filter(
      (task) =>
        !task.deletedAt &&
        !task.log &&
        task.status !== "done" &&
        !task.scheduledDate &&
        task.horizon === "now",
    )
    .sort((a, b) => taskScore(b) - taskScore(a));
  const completedToday = tasks
    .filter(
      (task) =>
        !task.deletedAt &&
        task.status === "done" &&
        task.completedAt &&
        compactDate(new Date(task.completedAt)) === today,
    )
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const activeSession = sessions
    .filter((session) =>
      !session.deletedAt && (session.status === "running" || session.status === "paused"))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const activeTask = activeSession
    ? tasks.find((task) => task.id === activeSession.taskId)
    : undefined;
  const focus = activeTask || flexibleTasks[0] || fixedTasks[0] || overdue[0] || inbox[0];
  const nextAnchor = runway.nextAnchor;
  const untilAnchor = nextAnchor ? Math.max(0, nextAnchor.startMinute - nowMinute) : null;
  const activeRemaining = activeSession
    ? (() => {
        const at = activeSession.status === "paused" && activeSession.pausedAt
          ? new Date(activeSession.pausedAt).getTime()
          : now;
        const elapsed = Math.max(
          0,
          Math.floor(
            (at - new Date(activeSession.startedAt).getTime()) / 1000 -
              activeSession.pausedTotalSec,
          ),
        );
        return activeSession.plannedMin * 60 - (activeSession.carriedElapsedSec || 0) - elapsed;
      })()
    : null;
  const finishActive = async (complete: boolean) => {
    if (!activeSession) return;
    await updateSession(activeSession.id, {
      status: complete ? "completed" : "interrupted",
      endedAt: new Date().toISOString(),
      pausedAt: null,
    }, complete ? "作業を完了" : "次の作業へ切り替え");
    if (complete && activeTask) await completeTask(activeTask.id, true);
    if (complete) announceCompletion().catch(() => undefined);
    syncNow().catch(() => undefined);
  };
  const focusUsual = focus ? usualMinutes(focus, sessions) : { minutes: 0, fromHistory: false };
  const autoDetour = Boolean(activeSession?.interrupt?.auto);
  const [armedDelete, setArmedDelete] = useState(false);
  // 実行中のタスクは上のカードに出ているので、リストには重ねない。
  const queueTasks = flexibleTasks.filter((task) => task.id !== focus?.id);
  const startNext = async () => {
    const next = flexibleTasks.find((task) => task.id !== activeTask?.id) || fixedTasks[0];
    await finishActive(false);
    if (next) onStart(next);
  };
  return (
    <div className="page-content today-page today-v3">
      <LeaveBanner />
      <RoundBreakBanner />
      <section className={`now-card${activeSession ? " running" : ""}`}>
        <span className="now-label">{autoDetour ? "おかえり" : activeSession ? "いま" : "次はこれ"}</span>
        {autoDetour && activeSession?.interrupt ? (
          <div className="now-back">
            <strong>寄り道 {Math.max(1, Math.round((now - Date.parse(activeSession.startedAt)) / 60_000))}分<small>（{activeSession.taskTitle.replace(/^(寄り道|割り込み)：/, "")}）</small></strong>
            <button className="now-back-main" type="button" onClick={() => returnFromInterrupt(activeSession, "continue")}>
              <Play size={18} fill="currentColor" />
              「{activeSession.interrupt.returnTitle}」の続きから
            </button>
            <button className="now-back-sub" type="button" onClick={() => returnFromInterrupt(activeSession, "stop")}>
              区切るだけ（記録して止める）
            </button>
          </div>
        ) : focus ? (
          <>
            <div className="now-main">
              <div className="now-text">
                <strong>{focus.title}</strong>
                {focus.doneWhen && <small className="now-goal">ゴール：{focus.doneWhen}</small>}
                <span className={activeRemaining !== null && activeRemaining < 0 ? "over" : ""}>
                  {activeSession && activeRemaining !== null
                    ? activeRemaining < 0
                      ? `${Math.ceil(Math.abs(activeRemaining) / 60)}分オーバー`
                      : `あと約${Math.max(1, Math.ceil(activeRemaining / 60))}分`
                    : `${usesRounds(focus) ? focus.estimateMin : focusUsual.minutes}分`}
                </span>
              </div>
              {activeSession && (
                <button className="now-start" type="button" onClick={() => onStart(focus)}>
                  <Play size={20} fill="currentColor" />
                  開く
                </button>
              )}
            </div>
            {activeSession && (
              <div className="now-actions">
                {activeTask && (
                  <button type="button" onClick={() => onEdit(activeTask)}>
                    <Pencil size={14} /> 編集
                  </button>
                )}
                <button type="button" onClick={async () => {
                  stopVoice();
                  await discardRunning(activeSession.taskId);
                  toast(`「${activeSession.taskTitle}」の開始を取り消しました`);
                  syncNow().catch(() => undefined);
                }}>
                  <Undo2 size={14} /> 取り消す
                </button>
                {/* 確認ダイアログに頼らず、2回押しで消す（iPhoneでも確実に効く）。 */}
                <button type="button" className={`danger${armedDelete ? " armed" : ""}`} onClick={async () => {
                  if (!armedDelete) {
                    setArmedDelete(true);
                    window.setTimeout(() => setArmedDelete(false), 3000);
                    return;
                  }
                  setArmedDelete(false);
                  stopVoice();
                  await discardRunning(activeSession.taskId);
                  await softDeleteTask(activeSession.taskId);
                  toast(`「${activeSession.taskTitle}」を消しました（ゴミ箱から戻せます）`);
                  syncNow().catch(() => undefined);
                }}>
                  <Trash2 size={14} /> {armedDelete ? "もう一度で消す" : "消す"}
                </button>
              </div>
            )}
            {!activeSession && (
              <div className="now-buttons">
                <button className="now-two" type="button" onClick={() => onStart(focus, { starter: true })}>
                  2分だけ
                  <small>手をつけるだけでOK</small>
                </button>
                <button className="now-full" type="button" onClick={() => onStart(focus)}>
                  <Play size={16} fill="currentColor" />
                  {usesRounds(focus) ? `15分ずつ（${Math.ceil(focus.estimateMin / 15)}回）` : `${focusUsual.minutes}分やる`}
                  {focusUsual.fromHistory && !usesRounds(focus) && <small>いつもの実績</small>}
                </button>
              </div>
            )}
            {!activeSession && (
              <div className="now-actions idle">
                {/* 開始し忘れたけどやった：いつもの長さで「今終わった」実績を残して完了。
                    時刻はあとでカレンダーのドラッグで直せる。 */}
                <button type="button" className="done" onClick={async () => {
                  const minutes = Math.max(5, focusUsual.minutes || focus.estimateMin || 15);
                  const end = new Date();
                  const added = await createManualFocusSession(focus, new Date(end.getTime() - minutes * 60_000).toISOString(), end.toISOString());
                  await completeTaskFromActual(focus.id, added.endedAt!, added.id);
                  announceCompletion().catch(() => undefined);
                  syncNow().catch(() => undefined);
                }}>
                  <Check size={14} /> 完了
                </button>
                <button type="button" onClick={() => onEdit(focus)}>
                  <Pencil size={14} /> 編集
                </button>
                <button type="button" onClick={async () => {
                  await updateTask(focus.id, { scheduledDate: null, startMinute: null, isFixed: false, status: "inbox" }, "今日から外す");
                  toast(`「${focus.title}」を今日から外しました（やることに残っています）`);
                  syncNow().catch(() => undefined);
                }}>
                  <CalendarX size={14} /> 外す
                </button>
                <button type="button" className={`danger${armedDelete ? " armed" : ""}`} onClick={async () => {
                  if (!armedDelete) {
                    setArmedDelete(true);
                    window.setTimeout(() => setArmedDelete(false), 3000);
                    return;
                  }
                  setArmedDelete(false);
                  await softDeleteTask(focus.id);
                  toast(`「${focus.title}」を消しました（ゴミ箱から戻せます）`);
                  syncNow().catch(() => undefined);
                }}>
                  <Trash2 size={14} /> {armedDelete ? "もう一度で消す" : "消す"}
                </button>
              </div>
            )}
            {activeSession && activeRemaining !== null && activeRemaining < 0 && (
              <details className="now-recover">
                <summary>長引いている → 決め直す</summary>
                <div>
                  <button type="button" onClick={() => {
                    setFocusSessionPlannedMinutes(activeSession.id, activeSession.plannedMin + 5)
                      .then(() => syncNow().catch(() => undefined));
                  }}>あと5分</button>
                  <button type="button" onClick={() => finishActive(true)}>ここで完了</button>
                  <button type="button" onClick={startNext}>次へ</button>
                  {activeTask && (
                    <button type="button" onClick={async () => {
                      await finishActive(false);
                      await updateTask(activeTask.id, {
                        scheduledDate: null,
                        startMinute: null,
                        isFixed: false,
                        status: "inbox",
                      }, "今日から外す");
                      syncNow().catch(() => undefined);
                    }}>今日から外す</button>
                  )}
                </div>
              </details>
            )}
          </>
        ) : (
          <p className="now-empty">今日やることはまだありません。下に入れるか、ルーティンから始められます。</p>
        )}
        <RoutineBar />
      </section>

      <TimeLeftStrip />
      <TodayProgress />
      <BudgetCard />
      <section className="today-list">
        <header>
          <h2>今日</h2>
          <span>
            {due.length ? `${due.length}件・約${runway.bufferedFlexibleMin}分 → ${runway.overflowMin ? `${runway.overflowMin}分入りきらない` : `${flowTimeLabel(runway.finishMinute)}ごろ終わる`}` : "すべて完了"}
          </span>
        </header>
        {nextAnchor && (
          <p className="today-anchor">
            次の固定予定：{nextAnchor.title}（{flowTimeLabel(nextAnchor.startMinute)}・{formatRelativeMinutes(untilAnchor || 0)}）
          </p>
        )}
        <QuickAdd defaultDate={today} />
        {queueTasks.length > 0 && (
          <DraggableTaskQueue
            tasks={queueTasks}
            onEdit={onEdit}
            onStart={onStart}
            onReorder={reorderFlexibleTasks}
          />
        )}
        {fixedTasks.length > 0 && (
          <div className="task-list today-fixed">
            {fixedTasks.map((task) => (
              <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} compact />
            ))}
          </div>
        )}
        {due.length > 0 && (
          <button className="today-wide" type="button" onClick={() => setRunwayOpen(true)}>
            <Maximize2 size={14} />
            時間の流れで見る
          </button>
        )}
      </section>

      {overdue.length > 0 && (
        <details className="today-fold warn">
          <summary><span>過ぎた予定</span><b>{overdue.length}件</b></summary>
          <div className="task-list">
            {overdue.map((task) => (
              <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} compact />
            ))}
          </div>
        </details>
      )}
      {completedToday.length > 0 && (
        <details className="today-fold">
          <summary><span>今日完了</span><b>{completedToday.length}件</b></summary>
          <div className="task-list">
            {completedToday.map((task) => {
              const actual = taskActualDuration(task.id, sessions);
              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  onEdit={onEdit}
                  onStart={onStart}
                  actualMin={actual?.activeMin}
                  actualReliable={actual?.reliable}
                  compact
                />
              );
            })}
          </div>
        </details>
      )}
      {inbox.length > 0 && (
        <button
          className="today-fold-link"
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "inbox" }))}
        >
          <span>日付のないこと</span>
          <b>{inbox.length}件</b>
          <ChevronRight size={16} />
        </button>
      )}
      <QuickRecord />
      {runwayOpen && (
        <div className="runway-fullscreen" role="dialog" aria-modal="true" aria-label="今日の流れを広く見る">
          <header>
            <div>
              <span className="section-kicker">TODAY · {formatMinute(nowMinute)}</span>
              <h2>今日の流れ</h2>
              <p>固定予定の間に、無理なく入る順番です。</p>
            </div>
            <IconButton label="閉じる" onClick={() => setRunwayOpen(false)}><X size={22} /></IconButton>
          </header>
          <div className="runway-fullscreen-grid">
            <section>
              <h3>順番を組み替える</h3>
              <DraggableTaskQueue
                tasks={flexibleTasks}
                onEdit={onEdit}
                onStart={onStart}
                onReorder={reorderFlexibleTasks}
              />
            </section>
            <RunwayTimeline entries={runway.entries} tasks={tasks} onEdit={onEdit} onStart={onStart} expanded />
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelativeMinutes(minutes: number): string {
  if (minutes < 1) return "まもなく";
  if (minutes < 60) return `あと${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `あと${hours}時間${rest ? `${rest}分` : ""}`;
}

function flowTimeLabel(minute: number): string {
  const dayOffset = Math.floor(minute / 1440);
  const normalized = ((minute % 1440) + 1440) % 1440;
  const time = formatMinute(normalized);
  return dayOffset > 0 ? `翌日 ${time}` : time;
}

function DraggableTaskQueue({
  tasks,
  onEdit,
  onStart,
  onReorder,
}: {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [orderedIds, setOrderedIds] = useState(() => tasks.map((task) => task.id));
  const orderedIdsRef = useRef(orderedIds);
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  useEffect(() => {
    if (draggingRef.current) return;
    const nextIds = tasks.map((task) => task.id);
    orderedIdsRef.current = nextIds;
    setOrderedIds(nextIds);
  }, [tasks]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((task): task is Task => Boolean(task));
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const id = draggingRef.current;
    if (!id) return;
    const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-runway-task]"));
    const target = elements.find((element) => {
      const rect = element.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    const targetId = target?.dataset.runwayTask;
    if (targetId === id) return;
    setOrderedIds((currentIds) => {
      const next = currentIds.filter((item) => item !== id);
      const targetIndex = targetId ? next.indexOf(targetId) : -1;
      next.splice(targetIndex < 0 ? next.length : targetIndex, 0, id);
      if (next.join() !== currentIds.join()) haptic("tick");
      orderedIdsRef.current = next;
      return next;
    });
  };
  const finishDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = null;
    setDragging(null);
    onReorder(orderedIdsRef.current);
  };
  return (
    <div
      className="runway-queue"
      onPointerMove={pointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {ordered.map((task, index) => (
        <SwipeableTask task={task} key={task.id}>
          <article className={`runway-queue-item${dragging === task.id ? " dragging" : ""}`} data-runway-task={task.id}>
          <button
            className="runway-drag-handle"
            type="button"
            aria-label={`${task.title}の順番を移動`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              draggingRef.current = task.id;
              setDragging(task.id);
            }}
          ><GripVertical size={20} /></button>
          <button className="runway-queue-main" type="button" onClick={() => onEdit(task)}>
            <span>{index + 1}</span>
            <strong>{task.title}</strong>
            <small>{task.estimateMin}分</small>
          </button>
          <IconButton label={`${task.title}を開始`} onClick={() => onStart(task)}><Play size={16} /></IconButton>
          </article>
        </SwipeableTask>
      ))}
      {!ordered.length && <div className="runway-queue-empty">固定予定以外のタスクはありません</div>}
    </div>
  );
}

function RunwayTimeline({
  entries,
  tasks,
  onEdit,
  onStart,
  expanded = false,
}: {
  entries: RunwayEntry[];
  tasks: Task[];
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
  expanded?: boolean;
}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return (
    <div className={`runway-timeline${expanded ? " expanded" : ""}`}>
      <h3>時間の見通し</h3>
      <ol>
        {entries.map((entry) => {
          const task = entry.kind === "task" ? byId.get(entry.id) : undefined;
          return (
            <li className={`${entry.fixed ? "fixed" : "flexible"}${entry.conflict ? " conflict" : ""}`} key={entry.id}>
              <span className="runway-time">{flowTimeLabel(entry.startMinute)}</span>
              <button type="button" disabled={!task} onClick={() => task && onEdit(task)}>
                <span>{entry.fixed ? <Lock size={13} /> : <span className="runway-dot" />}</span>
                <strong>{entry.title}</strong>
                <small>{entry.durationMin}分{entry.kind === "calendar" ? "・カレンダー" : ""}</small>
              </button>
              {task && !entry.fixed && (
                <IconButton label={`${task.title}を開始`} onClick={() => onStart(task)}><Play size={15} /></IconButton>
              )}
            </li>
          );
        })}
      </ol>
      {!entries.length && <div className="runway-queue-empty">予定を追加すると、ここに1日の流れが見えます</div>}
    </div>
  );
}

function CalendarPage({
  tasks,
  sessions,
  scheduleHistory,
  onEdit,
  onStart,
}: {
  tasks: Task[];
  sessions: FocusSession[];
  scheduleHistory: ScheduleHistoryEntry[];
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  const mobile = useMobile();
  const calendarRef = useRef<FullCalendar>(null);
  const backlogRef = useRef<HTMLDivElement>(null);
  const calendarSurfaceRef = useRef<HTMLElement>(null);
  const edgeMoveRef = useRef<{ taskId: string; direction: -1 | 1 } | null>(
    null,
  );
  const [mode, setMode] = useState<CalendarMode>(() => {
    const device = matchMedia("(max-width: 760px)").matches
      ? "mobile"
      : "desktop";
    const saved = localStorage.getItem(`sasshy-calendar-view-${device}`);
    return saved === "list" || saved === "day" || saved === "week" || saved === "month" || (saved === "three" && device === "mobile")
      ? saved
      : device === "mobile"
        ? "day"
        : "week";
  });
  const [title, setTitle] = useState("");
  const [activeDate, setActiveDate] = useState(todayKey());
  const [search, setSearch] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [compare, setCompare] = useState(false);
  const [dayList, setDayList] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [scheduleEditor, setScheduleEditor] = useState<{
    task: Task | null;
    seed: ScheduleDraftSeed;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const ignoreEventClickUntil = useRef(0);
  const googleCalendar =
    useLiveQuery(() => getGoogleCalendarConfig(), [], emptyGoogleCalendar) ||
    emptyGoogleCalendar;
  const unscheduled = tasks.filter(
    (task) =>
      !task.deletedAt &&
      task.status !== "done" &&
      !task.scheduledDate &&
      task.horizon === "now" &&
      task.title.toLowerCase().includes(search.toLowerCase()),
  );
  const visibleDayTasks = tasks
    .filter(
      (task) =>
        !task.deletedAt &&
        task.status !== "done" &&
        task.scheduledDate === activeDate,
    )
    .sort(compareDayFlowTasks);
  const moveVisibleDayTask = async (taskId: string, direction: -1 | 1) => {
    await reorderTasksForDay(
      visibleDayTasks.map((task) => task.id),
      taskId,
      direction,
    );
    syncNow().catch(() => undefined);
  };
  const events = useMemo<EventInput[]>(
    () =>
      tasks
        .filter(
          (task) =>
            !task.deletedAt && task.status !== "done" && task.scheduledDate,
        )
        .map((task) => {
          const start = taskStart(task)!;
          const allDay = task.startMinute === null;
          const end = allDay
            ? undefined
            : new Date(start.getTime() + task.durationMin * 60_000);
          return {
            id: task.id,
            title: task.title,
            start,
            end,
            allDay,
            editable: true,
            durationEditable: !allDay,
            classNames: [
              `task-event`,
              task.importance ? "is-important" : "",
              task.scheduledDate! < todayKey() ? "is-unconfirmed-past" : "",
            ].filter(Boolean),
            extendedProps: {
              taskId: task.id,
              flowOrder: task.flowOrder ?? 9999,
            },
          };
        }),
    [tasks],
  );
  const actualEvents = useMemo<EventInput[]>(() => {
    const completedSessions: EventInput[] = sessions
      .filter(
        (session) =>
          !session.deletedAt &&
          (session.status === "completed" ||
            session.status === "interrupted") &&
          session.endedAt,
      )
      .flatMap((session) => {
        const task = tasks.find((item) => item.id === session.taskId);
        if (!task || task.deletedAt || !session.endedAt) return [];
        const actual = sessionDuration(session);
        if (!actual) return [];
        const endedAt = new Date(session.endedAt);
        const visibleMinutes = actual.reliable
          ? actual.wallMin
          : Math.min(60, Math.max(1, session.plannedMin));
        const startedAt = actual.reliable
          ? new Date(session.startedAt)
          : new Date(endedAt.getTime() - visibleMinutes * 60_000);
        return [
          {
            id: `actual:${session.id}`,
            title: `実績 ${actual.activeMin}分${actual.reliable ? "" : "・要確認"} · ${task.title}`,
            start: startedAt,
            end: endedAt,
            allDay: false,
            editable: false,
            durationEditable: false,
            classNames: [
              "actual-event",
              actual.reliable ? "" : "is-suspect",
            ].filter(Boolean),
            extendedProps: { taskId: task.id, actualSession: true },
          } satisfies EventInput,
        ];
      });
    const taskIdsWithSessions = new Set(
      sessions
        .filter(
          (session) => !session.deletedAt && session.status === "completed",
        )
        .map((session) => session.taskId),
    );
    const manualCompletions = tasks
      .filter(
        (task) =>
          !task.deletedAt &&
          task.status === "done" &&
          task.completedAt &&
          !taskIdsWithSessions.has(task.id),
      )
      .map((task) => {
        const completedAt = new Date(task.completedAt!);
        return {
          id: `completion:${task.id}`,
          title: `完了 · ${task.title}`,
          start: new Date(completedAt.getTime() - 10 * 60_000),
          end: completedAt,
          allDay: false,
          editable: false,
          durationEditable: false,
          classNames: ["manual-completion-event"],
          extendedProps: { taskId: task.id, manualCompletion: true },
        } satisfies EventInput;
      });
    return [...completedSessions, ...manualCompletions];
  }, [sessions, tasks]);
  const resultEvents = useMemo<EventInput[]>(() => {
    const results = latestResultsByVersion(scheduleHistory);
    const snapshots = new Map<
      string,
      { snapshot: NonNullable<ScheduleHistoryEntry["before"]>; taskId: string }
    >();
    scheduleHistory.forEach((entry) => {
      [entry.before, entry.after].forEach((snapshot) => {
        if (snapshot?.scheduleVersionId) {
          snapshots.set(snapshot.scheduleVersionId, {
            snapshot,
            taskId: entry.taskId,
          });
        }
      });
    });
    return [...results.entries()].flatMap(([versionId, result]) => {
      if (result === "unconfirmed") return [];
      const version = snapshots.get(versionId);
      const snapshot = version?.snapshot;
      if (!version || !snapshot?.scheduledDate) return [];
      const [year, month, day] = snapshot.scheduledDate.split("-").map(Number);
      const start = new Date(year, month - 1, day);
      if (snapshot.startMinute !== null) {
        start.setHours(
          Math.floor(snapshot.startMinute / 60),
          snapshot.startMinute % 60,
          0,
          0,
        );
      }
      return [
        {
          id: `schedule-result:${versionId}`,
          title: `結果 ${scheduleResultLabel[result]} · ${snapshot.title}`,
          start,
          end:
            snapshot.startMinute === null
              ? undefined
              : new Date(start.getTime() + snapshot.durationMin * 60_000),
          allDay: snapshot.startMinute === null,
          editable: false,
          durationEditable: false,
          classNames: ["schedule-result-event", `is-${result}`],
          extendedProps: {
            taskId: version.taskId,
            scheduleResult: true,
          },
        } satisfies EventInput,
      ];
    });
  }, [scheduleHistory]);
  const calendarEvents = useMemo<EventInput[]>(
    () => [
      ...events,
      ...(showResults ? [...resultEvents, ...actualEvents] : []),
      ...(googleCalendar.enabled
        ? googleCalendar.events.map((event) => ({
            id: `google:${event.id}`,
            title: `${event.calendarName ? `${event.calendarName}・` : ""}${event.title}`,
            start: event.start,
            end: event.end || undefined,
            allDay: event.allDay,
            editable: false,
            classNames: ["google-event"],
            backgroundColor: event.color || undefined,
            borderColor: event.color || undefined,
            extendedProps: { googleCalendar: true },
          }))
        : []),
    ],
    [actualEvents, events, googleCalendar, resultEvents, showResults],
  );

  useEffect(() => {
    const last = googleCalendar.lastSyncAt
      ? new Date(googleCalendar.lastSyncAt).getTime()
      : 0;
    if (
      googleCalendar.enabled &&
      googleCalendar.feedUrl &&
      Date.now() - last > 15 * 60_000
    )
      refreshGoogleCalendar(googleCalendar).catch(() => undefined);
  }, [
    googleCalendar.enabled,
    googleCalendar.feedUrl,
    googleCalendar.lastSyncAt,
  ]);

  useEffect(() => {
    if (mobile || !backlogRef.current) return;
    const draggable = new Draggable(backlogRef.current, {
      itemSelector: ".backlog-card",
      eventData: (element) => ({
        id: element.dataset.taskId,
        title: element.dataset.title,
        duration: { minutes: Number(element.dataset.duration) || 5 },
      }),
    });
    return () => draggable.destroy();
  }, [mobile, unscheduled.length]);

  const viewFor = (nextMode: CalendarMode) =>
    nextMode === "list"
      ? "listWeek"
      : nextMode === "day" || nextMode === "three"
      ? "timeGridDay"
      : nextMode === "month"
        ? "dayGridMonth"
        : "timeGridWeek";
  const changeMode = (nextMode: CalendarMode) => {
    setMode(nextMode);
    localStorage.setItem(
      `sasshy-calendar-view-${mobile ? "mobile" : "desktop"}`,
      nextMode,
    );
    calendarRef.current?.getApi().changeView(viewFor(nextMode));
  };

  useEffect(() => {
    const saved = localStorage.getItem(
      `sasshy-calendar-view-${mobile ? "mobile" : "desktop"}`,
    );
    const nextMode =
      saved === "list" || saved === "day" || saved === "week" || saved === "month" || (saved === "three" && mobile)
        ? saved
        : mobile
          ? "day"
          : "week";
    if (nextMode === mode) return;
    setMode(nextMode);
    calendarRef.current?.getApi().changeView(viewFor(nextMode));
  }, [mobile]);

  const openScheduleDraft = (
    scheduledDate: string,
    startMinute: number | null,
    durationMin = 25,
  ) => {
    setScheduleEditor({
      task: null,
      seed: { scheduledDate, startMinute, durationMin },
    });
  };

  const openScheduleMove = (task: Task) => {
    setScheduleEditor({
      task,
      seed: {
        scheduledDate: task.scheduledDate || activeDate,
        startMinute: task.startMinute,
        durationMin: task.durationMin,
      },
    });
  };

  const showMessage = (nextMessage: string) => {
    setMessage(nextMessage);
    window.setTimeout(() => setMessage(""), 3600);
  };

  const saveEventDate = async (
    taskId: string,
    start: Date | null,
    end: Date | null,
    allDay: boolean,
    label: string,
  ) => {
    if (!start) return;
    const durationMin = end
      ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000))
      : undefined;
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const scheduledDate = compactDate(start);
    const startMinute = allDay
      ? null
      : start.getHours() * 60 + start.getMinutes();
    if (
      task.scheduledDate === scheduledDate &&
      task.startMinute === startMinute &&
      (!durationMin || task.durationMin === durationMin)
    ) return;
    await updateTask(taskId, {
      scheduledDate,
      startMinute,
      ...(durationMin ? { durationMin, estimateMin: durationMin } : {}),
    }, label);
    showMessage(
      `${task.title}を ${scheduledDate} ${formatMinute(startMinute)} へ移動しました`,
    );
    syncNow().catch(() => undefined);
  };

  const beginDurationResize = (
    pointer: ReactPointerEvent<HTMLSpanElement>,
    taskId: string,
  ) => {
    const task = tasks.find((item) => item.id === taskId);
    const eventElement =
      pointer.currentTarget.closest<HTMLElement>(".fc-timegrid-event");
    const slotElement = eventElement
      ?.closest(".fc-timegrid")
      ?.querySelector<HTMLElement>(".fc-timegrid-slot-lane");
    if (!task || !eventElement || !slotElement) return;

    pointer.preventDefault();
    pointer.stopPropagation();
    const handle = pointer.currentTarget;
    const pointerId = pointer.pointerId;
    const startY = pointer.clientY;
    const startHeight = eventElement.getBoundingClientRect().height;
    const startDuration = Math.max(1, task.durationMin);
    const slotHeight = Math.max(1, slotElement.getBoundingClientRect().height);
    let nextDuration = startDuration;
    let moved = false;
    setInteractionActive(true);
    document.body.classList.add("calendar-resizing");
    handle.setPointerCapture?.(pointerId);
    handle.dataset.duration = `${startDuration}分`;

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const deltaMinutes = Math.round(
        ((event.clientY - startY) / slotHeight) * 15,
      );
      nextDuration = Math.max(1, Math.min(720, startDuration + deltaMinutes));
      moved ||= Math.abs(event.clientY - startY) > 3;
      eventElement.style.height = `${Math.max(12, startHeight + ((nextDuration - startDuration) / 15) * slotHeight)}px`;
      handle.dataset.duration = `${nextDuration}分`;
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      handle.releasePointerCapture?.(pointerId);
      document.body.classList.remove("calendar-resizing");
      eventElement.style.height = "";
      delete handle.dataset.duration;
      setInteractionActive(false);
      if (!moved || nextDuration === startDuration) return;
      ignoreEventClickUntil.current = Date.now() + 600;
      updateTask(
        taskId,
        { durationMin: nextDuration, estimateMin: nextDuration },
        "カレンダーで時間を変更",
      ).then(() => {
        showMessage(`${task.title}を ${nextDuration}分に変更しました`);
        syncNow().catch(() => undefined);
      });
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const moveToAdjacentPeriod = async (taskId: string, direction: -1 | 1) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task?.scheduledDate) return;
    const [year, month, day] = task.scheduledDate.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (mode === "month") {
      const targetMonth = date.getMonth() + direction;
      const target = new Date(date.getFullYear(), targetMonth, 1);
      const lastDay = new Date(
        target.getFullYear(),
        target.getMonth() + 1,
        0,
      ).getDate();
      date.setFullYear(
        target.getFullYear(),
        target.getMonth(),
        Math.min(day, lastDay),
      );
    } else date.setDate(date.getDate() + direction * (mode === "week" ? 7 : 1));
    await updateTask(
      taskId,
      { scheduledDate: compactDate(date) },
      `カレンダーで${direction < 0 ? "前" : "次"}の期間へ移動`,
    );
    direction < 0
      ? calendarRef.current?.getApi().prev()
      : calendarRef.current?.getApi().next();
    syncNow().catch(() => undefined);
  };

  const finishEventDrag = (info: EventDragStopArg) => {
    setInteractionActive(false);
    setDraggingTaskId(null);
    if (mobile) return;
    const rect = calendarSurfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const edgeSize = Math.min(64, rect.width * 0.18);
    const direction: -1 | 1 | null =
      info.jsEvent.clientX <= rect.left + edgeSize
        ? -1
        : info.jsEvent.clientX >= rect.right - edgeSize
          ? 1
          : null;
    if (!direction) return;
    edgeMoveRef.current = { taskId: info.event.id, direction };
    ignoreEventClickUntil.current = Date.now() + 800;
    moveToAdjacentPeriod(info.event.id, direction).catch(() => undefined);
    window.setTimeout(() => {
      edgeMoveRef.current = null;
    }, 0);
  };

  // スマホの日・週は自前の表示なので、前後移動と見出しも日付から作る。
  const plannerActive = mobile && (mode === "day" || mode === "three" || mode === "week" || mode === "month" || mode === "list");
  const step = (direction: -1 | 1) => {
    if (!plannerActive) {
      if (direction < 0) calendarRef.current?.getApi().prev();
      else calendarRef.current?.getApi().next();
      return;
    }
    setActiveDate((current) => {
      if (mode === "month") {
        const d = new Date(`${current}T12:00:00`);
        const n = new Date(d.getFullYear(), d.getMonth() + direction, 1, 12);
        return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-01`;
      }
      return shiftDate(current, direction * (mode === "week" ? 7 : mode === "three" ? 3 : 1));
    });
  };
  const plannerTitle = (() => {
    const d = new Date(`${activeDate}T12:00:00`);
    if (mode === "month") return `${d.getFullYear()}年${d.getMonth() + 1}月`;
    if (mode === "three") {
      const last = new Date(d);
      last.setDate(d.getDate() + 2);
      return `${d.getMonth() + 1}/${d.getDate()} – ${last.getMonth() + 1}/${last.getDate()}`;
    }
    if (mode !== "week") return d.toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return `${monday.getMonth() + 1}/${monday.getDate()} – ${sunday.getMonth() + 1}/${sunday.getDate()}`;
  })();
  return (
    <div className={`calendar-page mode-${mode}${plannerActive ? " planner" : ""}`}>
      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <IconButton
            label="前へ"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={19} />
          </IconButton>
          <button
            className="button today-button"
            type="button"
            onClick={() => (plannerActive ? setActiveDate(todayKey()) : calendarRef.current?.getApi().today())}
          >
            今日
          </button>
          <IconButton
            label="次へ"
            onClick={() => step(1)}
          >
            <ChevronRight size={19} />
          </IconButton>
          <strong>{plannerActive ? plannerTitle : title}</strong>
        </div>
        <div className="calendar-toolbar-actions">
          {plannerActive && mode === "day" && (
            <>
              <button type="button" className={`dc-toggle${compare ? " active" : ""}`} aria-pressed={compare} onClick={() => { setCompare((v) => !v); setDayList(false); }}>
                予定と実際
              </button>
              <button type="button" className={`dc-toggle${dayList ? " active" : ""}`} aria-pressed={dayList} onClick={() => { setDayList((v) => !v); setCompare(false); }}>
                並べ替え
              </button>
            </>
          )}
          {!plannerActive && <label className="calendar-results-toggle">
            <input
              type="checkbox"
              checked={showResults}
              onChange={(event) => setShowResults(event.currentTarget.checked)}
            />
            実績も表示
          </label>}
          <div className="segmented" aria-label="カレンダー表示">
            {((mobile ? ["day", "three", "week", "month"] : ["day", "week", "month"]) as CalendarMode[]).map((item) => (
              <button
                key={item}
                type="button"
                className={mode === item ? "active" : ""}
                onClick={() => changeMode(item)}
              >
                {item === "list" ? "一覧" : item === "day" ? "日" : item === "three" ? "3日" : item === "week" ? "週" : "月"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mobile && mode === "day" && compare ? (
        <DayCompare date={activeDate} />
      ) : mobile && mode === "month" ? (
        <MonthGrid
          tasks={tasks}
          date={activeDate}
          onSelect={() => undefined}
          onCreateAt={(day, minute) => openScheduleDraft(day, minute, 15)}
          onOpen={openScheduleMove}
          onStart={onStart}
        />
      ) : mobile && (mode === "three" || (mode === "day" && !dayList)) ? (
        <TimeGrid
          tasks={tasks}
          sessions={sessions}
          onPage={(delta) => setActiveDate((current) => shiftDate(current, delta))}
          onSwipe={(dir) => setActiveDate((current) => shiftDate(current, dir * (mode === "three" ? 3 : 1)))}
          dates={mode === "three" ? threeDays(activeDate) : [activeDate]}
          onCreateAt={(day, minute) => openScheduleDraft(day, minute, 15)}
          onOpen={openScheduleMove}
          onStart={onStart}
        />
      ) : mobile && (mode === "day" || mode === "week" || mode === "list") ? (
        <MobilePlanner
          tasks={tasks}
          mode={mode === "week" ? "week" : "day"}
          date={activeDate}
          onDate={(next) => {
            setActiveDate(next);
            calendarRef.current?.getApi().gotoDate(next);
          }}
          onShowDay={(next) => {
            setActiveDate(next);
            if (mode !== "day") changeMode("day");
          }}
          onMove={openScheduleMove}
          onCreateAt={(day, minute) => openScheduleDraft(day, minute, 15)}
          onStart={onStart}
        />
      ) : (
      <div className="calendar-layout">
        {(!mobile || unscheduled.length > 0) && (
        <aside className={`backlog-panel${backlogOpen ? " open" : ""}`}>
          <button
            className="backlog-toggle"
            type="button"
            aria-expanded={mobile ? backlogOpen : true}
            onClick={() => mobile && setBacklogOpen((value) => !value)}
          >
            <div>
              <span className="section-kicker">UNSCHEDULED</span>
              <h2>日付なし</h2>
            </div>
            <span>{unscheduled.length}</span>
            {mobile && (backlogOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
          </button>
          {(!mobile || backlogOpen) && (
            <div className="backlog-body">
              <div className="backlog-search">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="絞り込み"
                />
              </div>
              <QuickAdd defaultDate={null} />
              <div ref={backlogRef} className="backlog-list">
                {unscheduled.map((task) => (
                  <div
                    key={task.id}
                    className="backlog-card"
                    data-task-id={task.id}
                    data-title={task.title}
                    data-duration={task.estimateMin}
                  >
                    <button type="button" onClick={() => onEdit(task)}>
                      <strong>{task.title}</strong>
                      <span>{task.estimateMin}分</span>
                    </button>
                    <IconButton label="タイマー" onClick={() => onStart(task)}>
                      <Play size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
        )}
        <section
          className={`calendar-surface${mode === "day" ? " has-day-order" : ""}`}
          ref={calendarSurfaceRef}
        >
          {draggingTaskId && !mobile && (
            <>
              <div className="calendar-edge-drop previous">
                <ChevronLeft size={20} />
                <span>
                  {mode === "day"
                    ? "前の日"
                    : mode === "week" || mode === "list"
                      ? "前の週"
                      : "前の月"}
                </span>
              </div>
              <div className="calendar-edge-drop next">
                <span>
                  {mode === "day"
                    ? "次の日"
                    : mode === "week" || mode === "list"
                      ? "次の週"
                      : "次の月"}
                </span>
                <ChevronRight size={20} />
              </div>
            </>
          )}
          {mode === "day" && visibleDayTasks.length > 0 && mobile && (
            <button
              className="calendar-order-toggle"
              type="button"
              aria-expanded={orderOpen}
              onClick={() => setOrderOpen((value) => !value)}
            >
              <span>この日の順番</span>
              <strong>{visibleDayTasks.length}件</strong>
              {orderOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
          {mode === "day" &&
            visibleDayTasks.length > 0 &&
            (!mobile || orderOpen) && (
            <section className="calendar-day-order" aria-label="表示日のタスク順">
              <header>
                <strong>この日の順番</strong>
                <span>上下で入れ替え</span>
              </header>
              <ol>
                {visibleDayTasks.map((task, index) => (
                  <li key={task.id}>
                    <span>{index + 1}</span>
                    <button type="button" onClick={() => mobile ? openScheduleMove(task) : onEdit(task)}>
                      <strong>{task.title}</strong>
                      <small>{formatMinute(task.startMinute)} · {task.estimateMin}分</small>
                    </button>
                    <div>
                      <IconButton
                        label={`${task.title}を上へ`}
                        disabled={index === 0}
                        onClick={() => moveVisibleDayTask(task.id, -1)}
                      >
                        <ChevronUp size={15} />
                      </IconButton>
                      <IconButton
                        label={`${task.title}を下へ`}
                        disabled={index === visibleDayTasks.length - 1}
                        onClick={() => moveVisibleDayTask(task.id, 1)}
                      >
                        <ChevronDown size={15} />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            )}
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
            noEventsContent="この週の予定はありません"
            listDayFormat={{ month: "numeric", day: "numeric", weekday: "short" }}
            listDaySideFormat={false}
            locale={jaLocale}
            initialView={viewFor(mode)}
            headerToolbar={false}
            firstDay={1}
            nowIndicator
            editable
            longPressDelay={350}
            eventLongPressDelay={350}
            selectable={!mobile && mode !== "month"}
            droppable={!mobile}
            dragScroll
            eventResizableFromStart
            allDaySlot
            allDayText="時刻なし"
            slotMinTime="06:00:00"
            slotMaxTime="25:00:00"
            slotDuration="00:15:00"
            snapDuration="00:01:00"
            scrollTime="08:00:00"
            height={mode === "month" ? "auto" : "100%"}
            dayMaxEvents={4}
            moreLinkClick={(info) => {
              setSelectedDate(compactDate(info.date));
            }}
            events={calendarEvents}
            eventOrder={(a: unknown, b: unknown) => {
              const first = a as { flowOrder?: number };
              const second = b as { flowOrder?: number };
              return (
                Number(first.flowOrder ?? 9999) -
                Number(second.flowOrder ?? 9999)
              );
            }}
            datesSet={(info: DatesSetArg) => {
              setTitle(formatCalendarTitle(info));
              const focusedDate = compactDate(info.view.calendar.getDate());
              setActiveDate(focusedDate);
              if (mobile && info.view.type === "timeGridWeek") {
                window.requestAnimationFrame(() => {
                  const surface = calendarSurfaceRef.current;
                  const target = surface?.querySelector<HTMLElement>(
                    `[data-date="${focusedDate}"]`,
                  );
                  if (!surface || !target) return;
                  const surfaceRect = surface.getBoundingClientRect();
                  const targetRect = target.getBoundingClientRect();
                  surface.scrollLeft +=
                    targetRect.left -
                    surfaceRect.left -
                    (surface.clientWidth - targetRect.width) / 2;
                });
              }
            }}
            dateClick={(info: DateClickArg) => {
              const date = info.dateStr.slice(0, 10);
              if (info.view.type === "dayGridMonth") {
                setSelectedDate(date);
                return;
              }
              openScheduleDraft(
                date,
                info.allDay
                  ? null
                  : info.date.getHours() * 60 + info.date.getMinutes(),
              );
            }}
            select={(info) => {
              if (mobile || info.view.type === "dayGridMonth") {
                setSelectedDate(compactDate(info.start));
                calendarRef.current?.getApi().unselect();
                return;
              }
              openScheduleDraft(
                compactDate(info.start),
                info.allDay
                  ? null
                  : info.start.getHours() * 60 + info.start.getMinutes(),
                info.end
                  ? Math.max(
                      1,
                      Math.round(
                        (info.end.getTime() - info.start.getTime()) / 60_000,
                      ),
                    )
                  : 5,
              );
              calendarRef.current?.getApi().unselect();
            }}
            eventContent={(info) => {
              const taskId = info.event.extendedProps.taskId || info.event.id;
              const task = tasks.find((item) => item.id === taskId);
              const readOnlyActual =
                info.event.extendedProps.actualSession ||
                info.event.extendedProps.manualCompletion;
              return (
                <div className="calendar-event-content">
                  <div className="calendar-event-copy">
                    {info.timeText && <b>{info.timeText}</b>}
                    <span>{info.event.title}</span>
                  </div>
                  {task &&
                    !readOnlyActual &&
                    !mobile &&
                    !info.event.allDay &&
                    info.view.type.startsWith("timeGrid") && (
                      <span
                        className="task-resize-grip"
                        role="separator"
                        aria-label={`${task.title}の時間を変更`}
                        title="上下にドラッグして時間を変更"
                        onPointerDown={(event) =>
                          beginDurationResize(event, task.id)
                        }
                      >
                        <GripHorizontal size={15} />
                      </span>
                    )}
                </div>
              );
            }}
            eventClick={(info: EventClickArg) => {
              if (Date.now() < ignoreEventClickUntil.current) return;
              const taskId = info.event.extendedProps.taskId || info.event.id;
              const task = tasks.find((item) => item.id === taskId);
              if (!task) return;
              if (
                mobile &&
                !info.event.extendedProps.actualSession &&
                !info.event.extendedProps.manualCompletion &&
                !info.event.extendedProps.scheduleResult
              ) openScheduleMove(task);
              else onEdit(task);
            }}
            eventDragStart={(info) => {
              setInteractionActive(true);
              setDraggingTaskId(info.event.id);
            }}
            eventDragStop={finishEventDrag}
            eventResizeStart={() => setInteractionActive(true)}
            eventResizeStop={() => setInteractionActive(false)}
            eventDrop={(info: EventDropArg) => {
              const edge = edgeMoveRef.current;
              if (edge?.taskId === info.event.id) {
                info.revert();
                return;
              }
              saveEventDate(
                info.event.id,
                info.event.start,
                info.event.end,
                info.event.allDay,
                "カレンダーで予定を移動",
              );
            }}
            eventResize={(info) =>
              saveEventDate(
                info.event.id,
                info.event.start,
                info.event.end,
                info.event.allDay,
                "カレンダーで時間を変更",
              )
            }
            eventReceive={(info) => {
              setInteractionActive(false);
              saveEventDate(
                info.event.id,
                info.event.start,
                info.event.end,
                info.event.allDay,
                "日付なしからカレンダーへ移動",
              );
              info.event.remove();
            }}
            eventClassNames={(arg) =>
              arg.event.extendedProps.taskId ? [] : ["external-event"]
            }
          />
          <div className="calendar-mobile-add">
            <button
              className="button primary"
              type="button"
              onClick={() =>
                openScheduleDraft(
                  mode === "day" ? activeDate : todayKey(),
                  null,
                )
              }
            >
              <Plus size={17} />
              予定を追加
            </button>
          </div>
          {selectedDate && (
            <CalendarDayDetail
              date={selectedDate}
              tasks={tasks}
              history={scheduleHistory}
              onClose={() => setSelectedDate(null)}
              onEdit={onEdit}
              onMove={openScheduleMove}
            />
          )}
        </section>
      </div>
      )}
      {scheduleEditor && (
        <ScheduleEditorSheet
          key={`${scheduleEditor.task?.id || "new"}:${scheduleEditor.seed.scheduledDate}:${scheduleEditor.seed.startMinute ?? "all-day"}`}
          task={scheduleEditor.task}
          seed={scheduleEditor.seed}
          onClose={() => setScheduleEditor(null)}
          onSaved={(_task, nextMessage) => {
            setScheduleEditor(null);
            showMessage(nextMessage);
          }}
          onOpenDetails={(task) => {
            setScheduleEditor(null);
            onEdit(task);
          }}
        />
      )}
      {message && <div className="action-toast">{message}</div>}
    </div>
  );
}

function InboxPage({
  tasks,
  onEdit,
  onStart,
}: {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  // 寄り道・割り込みの記録はやることではないので出さない。
  const open = (task: Task) => !task.deletedAt && !task.log && task.status !== "done";
  const inbox = tasks
    .filter((task) => open(task) && !task.scheduledDate && task.horizon === "now")
    .sort((a, b) => taskScore(b) - taskScore(a));
  const groups: { key: TaskHorizon; label: string; hint: string }[] = [
    { key: "waiting", label: "待ち", hint: "返事や到着を待っている" },
    { key: "someday", label: "いつか", hint: "今週ではないけれど残しておく" },
    { key: "wish", label: "やりたい", hint: "義務ではないアイデア" },
  ];
  const [openGroup, setOpenGroup] = useState<TaskHorizon | null>(null);
  const place = async (task: Task, changes: Partial<Task>, label: string) => {
    await updateTask(task.id, changes, label);
    syncNow().catch(() => undefined);
  };
  return (
    <div className="page-content todo-page">
      <QuickAdd />
      <section className="todo-section">
        <header>
          <h2>まだ日付のないこと</h2>
          <span>{inbox.length}件</span>
        </header>
        <p className="todo-hint">思いついたら上に入れておくだけでOK。決まったら「今日」「明日」へ。</p>
        {inbox.length ? (
          <ul className="todo-list">
            {inbox.map((task) => (
              <li key={task.id}>
                <button type="button" className="todo-title" onClick={() => onEdit(task)}>
                  <strong>{task.title}</strong>
                  <small>{task.estimateMin}分{task.doneWhen ? `・ゴール：${task.doneWhen}` : ""}</small>
                </button>
                <div className="todo-actions">
                  <button type="button" onClick={() => place(task, { scheduledDate: todayKey(), horizon: "now" }, "今日やる")}>今日</button>
                  <button type="button" onClick={() => place(task, { scheduledDate: shiftDate(todayKey(), 1), horizon: "now" }, "明日やる")}>明日</button>
                  <button type="button" onClick={() => place(task, { horizon: "someday" }, "いつかへ")}>いつか</button>
                  <button type="button" className="todo-play" aria-label={`${task.title}を開始`} onClick={() => onStart(task)}>
                    <Play size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="日付のないことはありません" detail="気になることを上からそのまま入力できます" />
        )}
      </section>
      {groups.map((group) => {
        const items = tasks.filter((task) => open(task) && task.horizon === group.key);
        const expanded = openGroup === group.key;
        return (
          <section className="todo-section todo-group" key={group.key}>
            <button type="button" className="todo-group-head" aria-expanded={expanded} onClick={() => setOpenGroup(expanded ? null : group.key)}>
              <div>
                <h2>{group.label}</h2>
                <small>{group.hint}</small>
              </div>
              <span>{items.length}件</span>
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {expanded && (
              <ul className="todo-list">
                {items.map((task) => (
                  <li key={task.id}>
                    <button type="button" className="todo-title" onClick={() => onEdit(task)}>
                      <strong>{task.title}</strong>
                    </button>
                    <div className="todo-actions">
                      <button type="button" onClick={() => place(task, { scheduledDate: todayKey(), horizon: "now" }, "今日やる")}>今日</button>
                      <button type="button" onClick={() => place(task, { horizon: "now", scheduledDate: null }, "日付なしへ戻す")}>戻す</button>
                    </div>
                  </li>
                ))}
                {!items.length && <li className="todo-empty">まだありません</li>}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LaterPage({
  tasks,
  onEdit,
  onStart,
}: {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  const groups: { key: TaskHorizon; label: string; hint: string }[] = [
    { key: "someday", label: "いつか", hint: "今週ではないけれど残しておく" },
    { key: "wish", label: "やりたい", hint: "義務ではないアイデア" },
    { key: "waiting", label: "待ち", hint: "返事や到着を待っている" },
  ];
  return (
    <div className="page-content">
      <section className="later-grid">
        {groups.map((group) => {
          const items = tasks.filter(
            (task) =>
              !task.deletedAt &&
              task.status !== "done" &&
              task.horizon === group.key,
          );
          return (
            <div className="later-column" key={group.key}>
              <header>
                <div>
                  <h2>{group.label}</h2>
                  <p>{group.hint}</p>
                </div>
                <span>{items.length}</span>
              </header>
              <button
                className="inline-add"
                type="button"
                onClick={() =>
                  createTask({
                    title: "新しいタスク",
                    horizon: group.key,
                  }).then(onEdit)
                }
              >
                <Plus size={17} />
                追加
              </button>
              <div className="task-list">
                {items.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onEdit={onEdit}
                    onStart={onStart}
                    compact
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function MemosPage({
  memos,
  onTaskCreated,
}: {
  memos: Memo[];
  onTaskCreated: (task: Task) => void;
}) {
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const visible = memos
    .filter(
      (memo) =>
        !memo.deletedAt &&
        !memo.archived &&
        `${memo.title} ${memo.body}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() && !body.trim()) return;
    await createMemo({
      title,
      body,
      reminderAt: reminderAt ? new Date(reminderAt).toISOString() : null,
    });
    setTitle("");
    setBody("");
    setReminderAt("");
    syncNow().catch(() => undefined);
  };
  return (
    <div className="page-content memo-page">
      <form className="memo-compose" onSubmit={add}>
        <div>
          <span className="section-kicker">PERSISTENT MEMO</span>
          <h2>消えないメモ</h2>
        </div>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="タイトル（省略可）"
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="覚えておきたいこと"
          rows={4}
        />
        <div className="memo-compose-footer">
          <label>
            <Bell size={16} />
            <input
              type="datetime-local"
              value={reminderAt}
              onChange={(event) => setReminderAt(event.target.value)}
            />
          </label>
          <button className="button primary" type="submit">
            保存
          </button>
        </div>
      </form>
      <div className="memo-filter">
        <Search size={17} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="メモを検索"
        />
        <span>{visible.length}件</span>
      </div>
      <div className="memo-grid">
        {visible.map((memo) => (
          <article className="memo-card" key={memo.id}>
            <header>
              <span>{memo.category}</span>
              <button
                type="button"
                className={memo.pinned ? "pin active" : "pin"}
                onClick={() =>
                  updateMemo(
                    memo.id,
                    { pinned: !memo.pinned },
                    memo.pinned ? "ピンを外す" : "ピン留め",
                  )
                }
              >
                PIN
              </button>
            </header>
            {memo.title && <h3>{memo.title}</h3>}
            <p>{memo.body}</p>
            {memo.reminderAt && (
              <div className="memo-reminder">
                <Bell size={15} />
                {formatStamp(memo.reminderAt)}
              </div>
            )}
            <footer>
              <button
                type="button"
                onClick={() =>
                  createTask({
                    title: memo.title || memo.body.slice(0, 40),
                    notes: memo.body,
                  }).then(onTaskCreated)
                }
              >
                <ListTodo size={16} />
                タスク化
              </button>
              <button
                type="button"
                onClick={() =>
                  updateMemo(memo.id, { archived: true }, "メモをアーカイブ")
                }
              >
                <Archive size={16} />
                保管
              </button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function HistoryPage({
  history,
  tasks,
}: {
  history: HistoryEntry[];
  tasks: Task[];
}) {
  const trash = tasks
    .filter((task) => task.deletedAt)
    .sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
  const completed = tasks
    .filter((task) => !task.deletedAt && task.status === "done")
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
    .slice(0, 30);
  const restoreAndSync = async (action: () => Promise<unknown>) => {
    await action();
    syncNow().catch(() => undefined);
  };
  return (
    <div className="page-content history-page">
      <div className="recovery-column">
        <section className="task-section page-section">
          <header>
            <div>
              <span className="section-kicker">COMPLETED</span>
              <h2>完了済み</h2>
              <p>間違って完了したタスクを戻せます。</p>
            </div>
            <span>{completed.length}件</span>
          </header>
          {completed.length ? (
            <div className="recovery-list">
              {completed.map((task) => (
                <div key={task.id}>
                  <div>
                    <strong>{task.title}</strong>
                    <span>{formatStamp(task.completedAt)}</span>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() =>
                      restoreAndSync(() => completeTask(task.id, false))
                    }
                  >
                    <RotateCcw size={16} />
                    完了取消
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="完了済みはありません"
              detail="完了したタスクがここに並びます"
            />
          )}
        </section>
        <section className="task-section page-section">
          <header>
            <div>
              <span className="section-kicker">TRASH</span>
              <h2>ゴミ箱</h2>
              <p>削除したタスクもここから戻せます。</p>
            </div>
            <span>{trash.length}件</span>
          </header>
          {trash.length ? (
            <div className="trash-list">
              {trash.map((task) => (
                <div key={task.id}>
                  <div>
                    <strong>{task.title}</strong>
                    <span>{formatStamp(task.deletedAt)}</span>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => restoreAndSync(() => restoreTask(task.id))}
                  >
                    <RotateCcw size={16} />
                    復元
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="ゴミ箱は空です"
              detail="削除操作でデータが即座に消えることはありません"
            />
          )}
        </section>
      </div>
      <section className="task-section page-section">
        <header>
          <div>
            <span className="section-kicker">CHANGE LOG</span>
            <h2>変更履歴</h2>
            <p>1件ずつ、変更前の状態へ戻せます。</p>
          </div>
          <span>最新{Math.min(history.length, 100)}件</span>
        </header>
        <div className="history-list">
          {history.slice(0, 100).map((entry) => (
            <div key={entry.id}>
              <div className="history-dot" />
              <div>
                <strong>{entry.label}</strong>
                <span>
                  {formatStamp(entry.createdAt)}・
                  {entry.source === "remote"
                    ? "他の端末"
                    : entry.source === "import"
                      ? "旧版取込"
                      : "この端末"}
                </span>
              </div>
              {entry.entityType === "task" && entry.before ? (
                <button
                  type="button"
                  onClick={() =>
                    restoreAndSync(() => restoreHistoryEntry(entry))
                  }
                >
                  <RotateCcw size={16} />
                  この前へ戻す
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsPage({
  tasks,
  memos,
  sessions,
}: {
  tasks: Task[];
  memos: Memo[];
  sessions: FocusSession[];
}) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [pushConfig, setPushConfig] = useState<PushConfig | null>(null);
  const [googleCalendar, setGoogleCalendar] =
    useState<GoogleCalendarConfig | null>(null);
  const [legacy, setLegacy] = useState<LegacySummary | null>(null);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getSyncConfig().then(setConfig);
    db.settings
      .get("voice")
      .then((value) => setVoiceConfig(value as unknown as VoiceConfig));
    getPushConfig().then(setPushConfig);
    getGoogleCalendarConfig().then(setGoogleCalendar);
    legacySummary().then(setLegacy);
  }, [tasks.length, memos.length]);
  if (!config || !voiceConfig || !pushConfig || !googleCalendar) return null;
  const pushSupport = getPushSupport();
  const legacyScheduledNotifications = tasks.filter((task) =>
    !task.deletedAt
    && task.status !== "done"
    && task.status !== "archived"
    && task.scheduledDate
    && task.startMinute !== null
    && task.scheduledStartNotification === undefined,
  ).length;
  const perform = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const next = await saveSyncConfig(config);
    setConfig(next);
  };
  const exportData = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupMessage("");
    try {
      const backup = await createBackup(db);
      downloadBackup(backup);
      const pending = backup.pending.records + backup.pending.schedules;
      setBackupMessage(
        `未送信${pending}件を含むバックアップの保存を開始しました。ダウンロードしたファイルを確認してください。`
        + (backup.references.missing.length ? ` 参照先が見つからない情報${backup.references.missing.length}件も、そのまま保存しています。` : ""),
      );
    } catch {
      setBackupMessage("バックアップを作成できませんでした。データと未送信の編集はそのままです。もう一度お試しください。");
    } finally {
      setBackupBusy(false);
    }
  };
  return (
    <div className="page-content settings-page">
      <AppearancePanel />
      <OpenCountPanel />
      <section className="settings-section">
        <header>
          <Cloud size={20} />
          <div>
            <h2>Mac・iPhone同期</h2>
            <p>タスク、メモ、作業記録を1件ずつ同期します。</p>
          </div>
        </header>
        <div className="sync-safety-note">
          <Check size={18} />
          <span>
            同期に失敗しても、この端末のデータは消しません。古い端末が全体を上書きすることもありません。
          </span>
        </div>
        <div className="form-stack">
          <label>
            <span>Supabase URL</span>
            <input
              value={config.url}
              onChange={(event) =>
                setConfig({ ...config, url: event.target.value })
              }
              placeholder="https://xxxxx.supabase.co"
            />
          </label>
          <label>
            <span>API key（publishable）</span>
            <input
              type="password"
              value={config.apiKey}
              onChange={(event) =>
                setConfig({ ...config, apiKey: event.target.value })
              }
            />
          </label>
          <label>
            <span>同期キー</span>
            <input
              type="password"
              value={config.syncKey}
              onChange={(event) =>
                setConfig({ ...config, syncKey: event.target.value })
              }
            />
          </label>
          <label className="toggle-row">
            <span>
              <strong>自動同期</strong>
              <small>15秒ごと・画面復帰時</small>
            </span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) =>
                setConfig({ ...config, enabled: event.target.checked })
              }
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={() =>
              perform(async () => {
                await save();
                await testSyncConnection(config);
              }, "接続できました")
            }
            disabled={busy}
          >
            設定保存・接続確認
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              perform(async () => {
                await save();
                await syncNow(true);
              }, "安全同期が完了しました")
            }
            disabled={busy}
          >
            <Cloud size={17} />
            今すぐ同期
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              navigator.clipboard
                .writeText(setupSql)
                .then(() => setMessage("Supabase SQLをコピーしました"))
            }
          >
            初期化SQLをコピー
          </button>
        </div>
        {message && <p className="settings-message">{message}</p>}
      </section>
      <section className="settings-section">
        <header>
          <CalendarDays size={20} />
          <div>
            <h2>Googleカレンダー</h2>
            <p>
              予定を読み込み専用で重ねます。SASSHYからGoogle側は変更しません。
            </p>
          </div>
        </header>
        <div className="form-stack">
          <label>
            <span>Apps Script WebアプリURL</span>
            <input
              value={googleCalendar.feedUrl}
              onChange={(event) =>
                setGoogleCalendar({
                  ...googleCalendar,
                  feedUrl: event.target.value,
                })
              }
              placeholder="https://script.google.com/macros/s/.../exec?token=..."
            />
          </label>
          <label className="toggle-row">
            <span>
              <strong>カレンダーに表示</strong>
              <small>
                {googleCalendar.events.length}件・最終更新{" "}
                {formatStamp(googleCalendar.lastSyncAt)}
              </small>
            </span>
            <input
              type="checkbox"
              checked={googleCalendar.enabled}
              onChange={(event) =>
                setGoogleCalendar({
                  ...googleCalendar,
                  enabled: event.target.checked,
                })
              }
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() =>
              perform(async () => {
                await saveGoogleCalendarConfig(googleCalendar);
                const next = await refreshGoogleCalendar(googleCalendar);
                setGoogleCalendar(next);
              }, "Googleカレンダーを更新しました")
            }
          >
            読み込み・更新
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              perform(
                async () => saveGoogleCalendarConfig(googleCalendar),
                "表示設定を保存しました",
              )
            }
          >
            設定だけ保存
          </button>
        </div>
        {googleCalendar.lastError && (
          <p className="settings-error">{googleCalendar.lastError}</p>
        )}
      </section>
      <section className="settings-section">
        <header>
          <SlidersHorizontal size={20} />
          <div>
            <h2>音声タイマー</h2>
            <p>画面を閉じた状態を含む読み上げを調整します。</p>
          </div>
        </header>
        <div className="form-stack">
          <label className="toggle-row">
            <span>
              <strong>音声案内</strong>
              <small>残り時間を日本語で読み上げます</small>
            </span>
            <input
              type="checkbox"
              checked={voiceConfig.enabled}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  enabled: event.target.checked,
                })
              }
            />
          </label>
          <label className="toggle-row">
            <span>
              <strong>少なめ音声コーチ</strong>
              <small>アプリを閉じていても、予定前などに最大3回/日だけ声をかけます</small>
            </span>
            <input
              type="checkbox"
              checked={voiceConfig.coachEnabled !== false}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  coachEnabled: event.target.checked,
                })
              }
            />
          </label>
          <label className="toggle-row">
            <span>
              <strong>AIの自然な声（iPhoneアプリ）</strong>
              <small>同じ言葉は2回目から無料。新しい言葉だけ1回約0.1円。電波がないときは今までの声</small>
            </span>
            <input
              type="checkbox"
              checked={voiceConfig.aiVoice !== false}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  aiVoice: event.target.checked,
                })
              }
            />
          </label>
          {voiceConfig.aiVoice !== false && (
            <div className="ai-voice-pick">
              <span>声の種類</span>
              <div className="ai-voice-options">
                {AI_VOICES.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={(voiceConfig.aiVoiceName || "marin") === v.id ? "active" : ""}
                    onClick={() => {
                      const next = { ...voiceConfig, aiVoiceName: v.id };
                      setVoiceConfig(next);
                      speakVoice("おつかれさま。あと5分、いっしょにやろう。", { ...next, enabled: true, aiVoice: true });
                    }}
                  >
                    <strong>{v.label}</strong>
                    <small>{v.note}</small>
                  </button>
                ))}
              </div>
              <small>押すと、その声で試しに話します（iPhoneアプリ）。</small>
            </div>
          )}
          <label>
            <span>通常の予定で準備を始める時間（分前）</span>
            <input
              type="number"
              min="5"
              max="180"
              step="5"
              value={voiceConfig.defaultPreparationMin ?? 20}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  defaultPreparationMin: Math.min(180, Math.max(5, Number(event.target.value) || 20)),
                })
              }
            />
            <small>通院・外出・電車・オンライン会議などは予定名から早め／短めに推測します</small>
          </label>
          <label className="toggle-row">
            <span>
              <strong>30秒ごとの時間案内</strong>
              <small>開始後、残り30秒まで30秒ごとに読み上げます</small>
            </span>
            <input
              type="checkbox"
              checked={voiceConfig.everyMinute !== false}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  everyMinute: event.target.checked,
                })
              }
            />
          </label>
          <label className="toggle-row">
            <span>
              <strong>終了前カウント</strong>
              <small>30秒・10秒・5秒から1秒まで読み上げます</small>
            </span>
            <input
              type="checkbox"
              checked={voiceConfig.finalCountdown !== false}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  finalCountdown: event.target.checked,
                })
              }
            />
          </label>
          <label>
            <span>追加で読み上げる残り時間（分、カンマ区切り）</span>
            <input
              value={voiceConfig.announcements.join(", ")}
              onChange={(event) =>
                setVoiceConfig({
                  ...voiceConfig,
                  announcements: event.target.value
                    .split(",")
                    .map(Number)
                    .filter((value) => Number.isFinite(value) && value > 0)
                    .sort((a, b) => b - a),
                })
              }
            />
          </label>
          <div className="range-grid">
            <label>
              <span>速さ {voiceConfig.rate.toFixed(1)}</span>
              <input
                type="range"
                min="0.6"
                max="1.6"
                step="0.1"
                value={voiceConfig.rate}
                onChange={(event) =>
                  setVoiceConfig({
                    ...voiceConfig,
                    rate: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>音量 {Math.round(voiceConfig.volume * 100)}%</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={voiceConfig.volume}
                onChange={(event) =>
                  setVoiceConfig({
                    ...voiceConfig,
                    volume: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
        </div>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={() =>
              perform(
                async () =>
                  db.settings.put({
                    id: "voice",
                    enabled: voiceConfig.enabled,
                    coachEnabled: voiceConfig.coachEnabled !== false,
                    defaultPreparationMin: voiceConfig.defaultPreparationMin ?? 20,
                    rate: voiceConfig.rate,
                    volume: voiceConfig.volume,
                    announcements: voiceConfig.announcements,
                    everyMinute: voiceConfig.everyMinute !== false,
                    finalCountdown: voiceConfig.finalCountdown !== false,
                  }),
                "音声設定を保存しました",
              )
            }
          >
            音声設定を保存
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              perform(async () => {
                if (
                  !speakVoice("音声案内のテストです", {
                    ...voiceConfig,
                    enabled: true,
                  })
                )
                  throw new Error("このブラウザでは音声を再生できません");
              }, "テスト音声を再生しました")
            }
          >
            <Volume2 size={17} />
            音声テスト
          </button>
        </div>
      </section>
      <section className="settings-section push-settings">
        <header>
          <Bell size={20} />
          <div>
            <h2>iPhoneバックグラウンド通知</h2><p className="settings-hint">音声追加の設定は画面上部の「Siri・仕事追加」を開いてください。</p>
            <p>
              SASSHYを閉じていても、通知ONにした予定の開始・タイマー終了・メモの時刻と、設定した仕事の未対応を通知します。
            </p>
          </div>
        </header>
        <div className={`push-status${pushConfig.enabled ? " active" : ""}`}>
          <span>
            <Bell size={18} />
          </span>
          <div>
            <strong>
              {pushConfig.enabled
                ? `${pushConfig.deviceName || "この端末"}の通知は有効です`
                : "この端末の通知は停止中です"}
            </strong>
            <small>
              {!pushSupport.supported || !pushSupport.installed
                ? pushSupport.reason
                : pushConfig.enabled
                  ? `登録 ${formatStamp(pushConfig.lastRegisteredAt)}`
                  : "端末ごとに一度だけ有効化します"}
            </small>
          </div>
        </div>
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            disabled={
              busy || !pushSupport.supported || !pushSupport.installed
            }
            onClick={() =>
              perform(async () => {
                setPushConfig(await enablePushNotifications());
              }, "この端末のバックグラウンド通知を有効にしました")
            }
          >
            <Bell size={17} />
            {pushConfig.enabled ? "通知を再登録" : "この端末で通知を有効"}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy || !pushConfig.enabled}
            onClick={() =>
              perform(async () => {
                setPushConfig(await testPushNotification());
              }, "テスト通知を送信しました")
            }
          >
            テスト通知
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy || !pushConfig.enabled}
            onClick={() =>
              perform(async () => {
                setPushConfig(await disablePushNotifications());
              }, "この端末の通知を停止しました")
            }
          >
            通知を停止
          </button>
        </div>
        {legacyScheduledNotifications > 0 && (
          <div className="notification-migration-note">
            <strong>予定通知の選択記録がないタスクが{legacyScheduledNotifications}件あります</strong>
            <span>
              服薬など必要な通知を一括停止しないため、旧データは通知ONを一時継続しています。
              各タスクの編集画面で、必要なものだけON、不要なものはOFFにしてください。
            </span>
          </div>
        )}
        <p className="settings-hint">
          新しいタスクの予定開始通知は既定OFFです。iPhoneではSafariの共有メニューからホーム画面に追加し、そのSASSHYアイコンから設定してください。タイマー終了通知は1回だけ届き、無反応を理由に追撃しません。
        </p>
      </section>
      <section className="settings-section">
        <header>
          <Upload size={20} />
          <div>
            <h2>旧版から移行</h2>
            <p>旧版は変更せず、v2へコピーします。</p>
          </div>
        </header>
        {legacy?.available ? (
          <div className="migration-box">
            <div>
              <strong>
                旧版：タスク{legacy.tasks}件・メモ{legacy.memos}件
              </strong>
              <span>
                取込済み：タスク{legacy.alreadyImportedTasks}件・メモ
                {legacy.alreadyImportedMemos}件
              </span>
            </div>
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const result = await importLegacy();
                  await syncNow().catch(() => undefined);
                  setLegacy(await legacySummary());
                  return result;
                }, "旧版データをコピーしました")
              }
            >
              未取込分をコピー
            </button>
          </div>
        ) : (
          <p className="muted">
            この端末・このURLには旧版のデータが見つかりません。
          </p>
        )}
      </section>
      <section className="settings-section">
        <header>
          <Download size={20} />
          <div>
            <h2>バックアップ</h2>
            <p>未送信の編集・予定履歴・ゴミ箱を含め、JSONで保存します。</p>
          </div>
        </header>
        <div className="data-summary">
          <span>
            タスク<strong>{tasks.length}</strong>
          </span>
          <span>
            メモ<strong>{memos.length}</strong>
          </span>
          <span>
            作業記録<strong>{sessions.length}</strong>
          </span>
        </div>
        <p className="settings-hint">
          音声設定も保存します。同期キー・通知の購読情報・カレンダーの接続URLは含みません。接続設定は再設定が必要です。
          ファイルにはタスクやメモの内容が含まれます。
        </p>
        <button className="button secondary" type="button" disabled={backupBusy} onClick={exportData}>
          <Download size={17} />
          {backupBusy ? "バックアップを作成中…" : "バックアップを書き出す"}
        </button>
        {backupMessage && <p className="settings-message" role="status">{backupMessage}</p>}
      </section>
    </div>
  );
}

const AI_VOICES = [
  { id: "marin", label: "マリン", note: "ChatGPTの声・やわらかい" },
  { id: "cedar", label: "シダー", note: "ChatGPTの声・落ち着いた" },
  { id: "coral", label: "コーラル", note: "明るい（今までの声）" },
  { id: "shimmer", label: "シマー", note: "さわやか" },
];

const toast = (text: string) => window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: text }));

/** Undo a start: every running/paused timer of this task is removed (not just the newest). */
async function discardRunning(taskId: string): Promise<void> {
  const open = (await db.sessions.where("taskId").equals(taskId).toArray())
    .filter((s) => !s.deletedAt && (s.status === "running" || s.status === "paused"));
  for (const s of open) await discardFocusSession(s.id);
}

function TimerDock({
  session,
  task,
  voice,
  onClose,
}: {
  session: FocusSession;
  task?: Task;
  voice: VoiceConfig;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [voiceNeedsTap, setVoiceNeedsTap] = useState(false);
  const [durationDraft, setDurationDraft] = useState(String(session.plannedMin));
  const [fixOpen, setFixOpen] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const [stopDraft, setStopDraft] = useState("");
  const [fixError, setFixError] = useState("");
  // 始めて最初の2分だけ「何分で・どこまで」を決める欄を出す（開始前には何も聞かない）。
  const [goalDraft, setGoalDraft] = useState(task?.doneWhen || "");
  const [setupClosed, setSetupClosed] = useState(false);
  const announced = useRef(new Set<number>());
  const previous = useRef<number | null>(null);
  const previousPlannedMinutes = useRef(session.plannedMin);
  const paused = session.status === "paused";
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setDurationDraft(String(session.plannedMin));
  }, [session.plannedMin]);
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    if ("wakeLock" in navigator && session.status === "running")
      (
        navigator as Navigator & {
          wakeLock: {
            request: (
              type: "screen",
            ) => Promise<{ release: () => Promise<void> }>;
          };
        }
      ).wakeLock
        .request("screen")
        .then((value) => {
          lock = value;
        })
        .catch(() => undefined);
    return () => {
      lock?.release().catch(() => undefined);
    };
  }, [session.status]);
  const remainingAt = (at: number) => {
    const start = new Date(session.startedAt).getTime();
    const pauseExtra =
      paused && session.pausedAt
        ? Math.max(0, at - new Date(session.pausedAt).getTime())
        : 0;
    const elapsedSec = Math.max(
      0,
      Math.floor(
        (at - start - session.pausedTotalSec * 1000 - pauseExtra) / 1000,
      ),
    );
    return (
      session.plannedMin * 60 - (session.carriedElapsedSec || 0) - elapsedSec
    );
  };
  const remainingSec = remainingAt(now);
  useEffect(() => {
    if (previousPlannedMinutes.current === session.plannedMin) return;
    // 延長前に読み上げ済みだった「残り30秒」などを、新しい期限でも
    // 読み上げられるようにリセットする。
    announced.current.clear();
    previous.current = remainingAt(Date.now());
    previousPlannedMinutes.current = session.plannedMin;
  }, [session.plannedMin]);
  useEffect(() => {
    if (!voice.enabled || paused) {
      previous.current = remainingSec;
      return;
    }
    // 励まし：始めて30秒（最初の壁を越えた）と、半分。1回ずつ。
    const totalSec = session.plannedMin * 60 - (session.carriedElapsedSec || 0);
    const ENCOURAGE_START = -100_000;
    const ENCOURAGE_HALF = -100_001;
    if (
      previous.current !== null && totalSec >= 120 &&
      previous.current > totalSec - 30 && remainingSec <= totalSec - 30 &&
      !announced.current.has(ENCOURAGE_START)
    ) {
      speakVoice("もう始まってる、いい感じ", voice);
      announced.current.add(ENCOURAGE_START);
    }
    if (
      previous.current !== null && totalSec >= 240 &&
      previous.current > totalSec / 2 && remainingSec <= totalSec / 2 &&
      !announced.current.has(ENCOURAGE_HALF)
    ) {
      speakVoice("半分きた", voice);
      announced.current.add(ENCOURAGE_HALF);
    }
    if (remainingSec >= 0) {
      for (const threshold of announcementThresholds(voice, session.plannedMin)) {
        if (
          previous.current !== null &&
          previous.current > threshold &&
          remainingSec <= threshold &&
          !announced.current.has(threshold)
        ) {
          speakVoice(announcementText(threshold), voice);
          announced.current.add(threshold);
        }
      }
    }
    if (
      previous.current !== null &&
      previous.current > 0 &&
      remainingSec <= 0
    ) {
      speakVoice("予定時間になりました", voice);
    }
    if (remainingSec < 0) {
      const previousOvertime = Math.max(0, -(previous.current ?? 0));
      const overtime = -remainingSec;
      const step = overtimeReminderStep(previousOvertime, overtime);
      if (step !== null && !announced.current.has(-step)) {
        speakVoice(remainingStatusText(-step), voice);
        announced.current.add(-step);
      }
    }
    previous.current = remainingSec;
  }, [remainingSec, paused, voice]);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        stopVoice();
        setVoiceNeedsTap(true);
        previous.current = null;
        return;
      }
      const current = remainingAt(Date.now());
      setNow(Date.now());
      previous.current = current;
      setVoiceNeedsTap(true);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [
    paused,
    session.startedAt,
    session.pausedAt,
    session.pausedTotalSec,
    session.plannedMin,
    session.carriedElapsedSec,
    voice,
  ]);
  const display = Math.abs(remainingSec);
  const time = `${String(Math.floor(display / 60)).padStart(2, "0")}:${String(display % 60).padStart(2, "0")}`;
  const pauseToggle = async () => {
    if (paused) {
      const resumed = await resumeFocusSession(session.id);
      if (resumed && voice.enabled) {
        stopVoice();
        speakVoice(
          `タイマーを再開します。${remainingStatusText(remainingAt(Date.now()))}`,
          voice,
        );
        setVoiceNeedsTap(false);
      }
    } else {
      await pauseFocusSession(session.id);
      stopVoice();
    }
  };
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const voiceControl = async () => {
    if (listening) return;
    setListening(true);
    setHeard("");
    const { text, error } = await listenOnce();
    setListening(false);
    if (error) { setHeard(error); return; }
    const command = parseVoiceCommand(text);
    if (command.kind === "extend") {
      const live = await db.sessions.get(session.id);
      if (live) await setFocusSessionPlannedMinutes(live.id, live.plannedMin + command.minutes);
      setHeard(`「${text}」→ ${command.minutes}分延長しました`);
      if (voice.enabled) speakVoice(`${command.minutes}分延長しました`, voice);
    } else if (command.kind === "pause") {
      if (!paused) await pauseToggle();
      setHeard(`「${text}」→ 一時停止しました`);
    } else if (command.kind === "resume") {
      if (paused) await pauseToggle();
      setHeard(`「${text}」→ 再開しました`);
    } else if (command.kind === "complete") {
      setHeard(`「${text}」→ 完了にします`);
      await finish(true);
      return;
    } else {
      setHeard(text ? `「${text}」はわかりませんでした（例：あと5分・止めて・終わった）` : "聞き取れませんでした");
    }
    syncNow().catch(() => undefined);
  };
  const finish = async (complete: boolean) => {
    if (!complete) {
      await pauseFocusSession(session.id, "作業を中断");
      stopVoice();
      syncNow().catch(() => undefined);
      onClose();
      return;
    }
    await updateSession(
      session.id,
      {
        status: "completed",
        endedAt: new Date().toISOString(),
        pausedAt: null,
      },
      "作業を完了",
    );
    if (task) await completeTask(task.id, true);
    syncNow().catch(() => undefined);
    announceCompletion().catch(() => undefined);
    // ルーティンなら、完了したらそのまま次のステップを始める（夜ルーティンで効いた流れ）。
    const next = await nextRoutineTask(task);
    if (next) {
      const minutes = usualMinutes(next, await db.sessions.toArray()).minutes;
      await startFocusSession(next, minutes);
      if (voice.enabled) speakVoice(`次は${next.title}、${minutes}分`, voice);
      return;
    }
    // ルーティンを最後までやったら、習慣のカレンダーに自動で✓。
    if (task?.routine) checkRoutineHabit(task.routine.name, todayKey()).then(() => syncNow().catch(() => undefined)).catch(() => undefined);
    onClose();
  };
  // 「別の作業をしていて、止めるのを忘れた」時の修正。
  const stopAt = async (at: Date) => {
    setFixError("");
    try {
      await stopFocusSessionAt(session.id, at.toISOString());
      stopVoice();
      setFixOpen(false);
      syncNow().catch(() => undefined);
    } catch (error) {
      setFixError(error instanceof Error ? error.message : String(error));
    }
  };
  const stopAtDraft = () => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(stopDraft);
    if (!match) {
      setFixError("時刻を選んでください");
      return;
    }
    const at = new Date();
    at.setHours(Number(match[1]), Number(match[2]), 0, 0);
    // 日付をまたいだ作業（例：23:50開始→0:10に修正）は前日の時刻として扱う。
    if (at.getTime() > Date.now()) at.setDate(at.getDate() - 1);
    stopAt(at);
  };
  const restart = async () => {
    stopVoice();
    await restartFocusSession(session.id);
    setFixOpen(false);
    syncNow().catch(() => undefined);
  };
  const discard = async (ask = true) => {
    if (ask && !window.confirm("このタイマーの記録を取り消しますか？（作業していなかった時用）")) return;
    stopVoice();
    await discardRunning(session.taskId);
    toast(`「${session.taskTitle}」の開始を取り消しました`);
    syncNow().catch(() => undefined);
    onClose();
  };
  const startedMs = new Date(session.startedAt).getTime();
  const stopChoices = [5, 15, 30, 60]
    .map((min) => ({ min, at: new Date(Date.now() - min * 60_000) }))
    .filter(({ at }) => at.getTime() > startedMs);
  const showSetup =
    !task?.routine && !session.starter && !session.round && !session.interrupt && !setupClosed && !paused && now - new Date(session.startedAt).getTime() < 120_000;
  const saveGoal = async () => {
    if (!task || goalDraft.trim() === (task.doneWhen || "")) return;
    await updateTask(task.id, { doneWhen: goalDraft.trim() }, "終わりの目安を設定");
    syncNow().catch(() => undefined);
  };
  const restoreVoice = () => {
    stopVoice();
    const restored = speakVoice(
      `音声を再開します。${remainingStatusText(remainingAt(Date.now()))}`,
      { ...voice, enabled: true },
    );
    setVoiceNeedsTap(!restored);
  };
  const changeDuration = async (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    const nextMinutes = Math.max(1, Math.min(480, Math.round(nextValue)));
    setDurationDraft(String(nextMinutes));
    await setFocusSessionPlannedMinutes(session.id, nextMinutes);
    syncNow().catch(() => undefined);
  };
  return (
    <div className="timer-dock">
      <div className="timer-title">
        <span className="live-dot" />
        <div>
          <span>
            {paused
              ? remainingSec < 0 ? "一時停止（予定を超過）" : "一時停止"
              : remainingSec < 0
                ? "予定を超過"
                : session.carriedElapsedSec
                  ? `累計${Math.round(session.carriedElapsedSec / 60)}分から再開`
                  : "集中しています"}
          </span>
          <strong>{session.taskTitle}</strong>
          {task?.routine && (
            <small className="timer-goal">
              {task.routine.name} {task.routine.index + 1}/{task.routine.count}
            </small>
          )}
          {task?.doneWhen && !showSetup && <small className="timer-goal">ゴール：{task.doneWhen}</small>}
        </div>
        <IconButton label="小さくする" onClick={onClose}>
          <X size={19} />
        </IconButton>
      </div>
      <button className="timer-display timer-ring" type="button" onClick={pauseToggle}>
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="100" cy="100" r="90" className="ring-bg" />
          <circle
            cx="100"
            cy="100"
            r="90"
            className={`ring-fg${remainingSec < 0 ? " over" : ""}${paused ? " paused" : ""}`}
            style={{
              strokeDasharray: 565.5,
              strokeDashoffset: remainingSec < 0
                ? 0
                : 565.5 * (1 - Math.max(0, remainingSec) / Math.max(1, session.plannedMin * 60 - (session.carriedElapsedSec || 0))),
            }}
          />
        </svg>
        <span>
          {remainingSec < 0 ? "+" : ""}
          {time}
        </span>
        <small>{paused ? "押して再開" : "押して一時停止"}</small>
      </button>
      <RoundBar session={session} />
      {showSetup && (
        <div className="timer-setup" aria-label="何分で・どこまでやるか">
          <div className="timer-setup-row">
            <span>何分でやる？</span>
            {[10, 15, 25].map((min) => (
              <button
                key={min}
                type="button"
                className={session.plannedMin === min ? "active" : ""}
                onClick={() => changeDuration(min)}
              >
                {min}分
              </button>
            ))}
          </div>
          <label className="timer-setup-goal">
            <span>ここまでやったら終わり</span>
            <input
              value={goalDraft}
              placeholder="例：机①の上の書類だけ"
              onChange={(event) => setGoalDraft(event.currentTarget.value)}
              onBlur={saveGoal}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveGoal();
                  setSetupClosed(true);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="timer-setup-close"
            onClick={() => {
              saveGoal();
              setSetupClosed(true);
            }}
          >
            このまま進める
          </button>
        </div>
      )}
      <div className="timer-duration-editor">
        <button type="button" onClick={() => changeDuration(session.plannedMin - 1)}>
          -1
        </button>
        <label>
          <span>タイマー</span>
          <input
            type="number"
            min="1"
            max="480"
            step="1"
            inputMode="numeric"
            aria-label="タイマー時間（分）"
            value={durationDraft}
            onChange={(event) => setDurationDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") changeDuration(Number(durationDraft));
            }}
          />
          <small>分</small>
        </label>
        <button type="button" onClick={() => changeDuration(Number(durationDraft))}>
          変更
        </button>
        <button type="button" onClick={() => changeDuration(session.plannedMin + 1)}>
          +1
        </button>
      </div>
      <button
        className={`timer-voice-resume${voiceNeedsTap ? " needed" : ""}`}
        type="button"
        onClick={restoreVoice}
      >
        <Volume2 size={16} />
        {voiceNeedsTap
          ? "Safariから戻りました・音声を再開"
          : "音声が聞こえない時はここを押す"}
      </button>
      <button
        className="timer-fix-toggle"
        type="button"
        aria-expanded={fixOpen}
        onClick={() => {
          setFixOpen(!fixOpen);
          setFixError("");
        }}
      >
        <RotateCcw size={15} />
        止め忘れた・やり直したい
      </button>
      {fixOpen && (
        <div className="timer-fix" aria-label="タイマーの修正">
          <p>
            別の作業をしていた時刻から止まっていたことにできます。止まっていた間は作業時間に数えません。
          </p>
          <div className="timer-fix-choices">
            {stopChoices.map(({ min, at }) => (
              <button key={min} type="button" onClick={() => stopAt(at)}>
                {min}分前
                <small>{at.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</small>
              </button>
            ))}
            <button type="button" onClick={() => stopAt(new Date(startedMs))}>
              開始時
              <small>{new Date(startedMs).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</small>
            </button>
          </div>
          <label className="timer-fix-time">
            <span>時刻を指定</span>
            <input
              type="time"
              value={stopDraft}
              onChange={(event) => setStopDraft(event.currentTarget.value)}
            />
            <button type="button" onClick={stopAtDraft}>
              ここで止まっていた
            </button>
          </label>
          {fixError && <p className="timer-fix-error">{fixError}</p>}
          <div className="timer-fix-actions">
            <button className="button secondary" type="button" onClick={restart}>
              <Play size={15} />
              今からやり直す
            </button>
            <button className="button secondary" type="button" onClick={() => discard()}>
              <Trash2 size={15} />
              記録を取り消す
            </button>
          </div>
        </div>
      )}
      <div className="timer-controls">
        <IconButton label={paused ? "再開" : "一時停止"} onClick={pauseToggle}>
          {paused ? <Play size={21} /> : <Pause size={21} />}
        </IconButton>
        <button
          className="button secondary"
          type="button"
          onClick={() => finish(false)}
        >
          <Square size={16} />
          中断
        </button>
        <button
          className="button complete"
          type="button"
          onClick={() => finish(true)}
        >
          <Check size={17} />
          完了
        </button>
      </div>
      {canListen() && (
        <div className="timer-voice">
          <button type="button" className={listening ? "on" : ""} onClick={voiceControl} disabled={listening}>
            <Mic size={16} /> {listening ? "聞いています…（5秒）" : "声で操作（あと5分・止めて・終わった）"}
          </button>
          {heard && <small>{heard}</small>}
        </div>
      )}
      <div className="timer-undo-row">
        <button type="button" onClick={() => discard(false)}>
          <Undo2 size={15} /> 開始を取り消す
        </button>
        <button type="button" className={`danger${armedDelete ? " armed" : ""}`} onClick={async () => {
          if (!armedDelete) {
            setArmedDelete(true);
            window.setTimeout(() => setArmedDelete(false), 3000);
            return;
          }
          stopVoice();
          await discardRunning(session.taskId);
          await softDeleteTask(session.taskId);
          toast(`「${session.taskTitle}」を消しました（ゴミ箱から戻せます）`);
          syncNow().catch(() => undefined);
          onClose();
        }}>
          <Trash2 size={15} /> {armedDelete ? "もう一度押すと消す" : "このタスクを消す"}
        </button>
      </div>
    </div>
  );
}

function App() {
  const mobile = useMobile();
  const [taskLink] = useState(() => parseTaskLink(window.location.href));
  const [incomingTask, setIncomingTask] = useState<ParsedTaskLink | null>(() => taskLink.task);
  const startTimerRef = useRef<((task: Task, opts?: StartOptions) => Promise<void>) | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const requested = new URLSearchParams(location.search).get("open");
    return requested && requested in PAGE_LABEL ? (requested as Page) : "today";
  });
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { restoreBudgetCardOnce().catch(() => undefined); }, []);
  // 画面の左端から右へスワイプでメニュー、メニューを左へスワイプで閉じる。
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      // カレンダーでタスクをつかんでいる間は、メニューのスワイプにしない。
      if (document.body.classList.contains("sasshy-dragging")) { start = null; return; }
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      if (start.x < 28 && dx > 60 && dy < 50) setMenuOpen(true);
      else if (dx < -60 && dy < 50) setMenuOpen(false);
      start = null;
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchend", up, { passive: true });
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchend", up);
    };
  }, []);
  const [editing, setEditing] = useState<Task | null>(null);
  const [timerVisible, setTimerVisible] = useState(true);
  const [actionMessage, setActionMessage] = useState("");
  const [syncState, setSyncState] = useState<SyncState>(getSyncState());
  // Unsent edits must be visible at a glance (they piled up unnoticed before).
  const pendingCount = useLiveQuery(() => db.outbox.count(), [], 0) || 0;
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const history =
    useLiveQuery(
      () => db.history.orderBy("createdAt").reverse().toArray(),
      [],
      [],
    ) || [];
  const scheduleHistory =
    useLiveQuery(
      () => db.scheduleHistory.orderBy("occurredAt").reverse().toArray(),
      [],
      [],
    ) || [];
  const scheduleOutbox =
    useLiveQuery(() => db.scheduleOutbox.toArray(), [], []) || [];
  const voice = useLiveQuery(
    () => db.settings.get("voice") as Promise<VoiceConfig | undefined>,
    [],
    undefined,
  );
  const coachCalendar = useLiveQuery(
    () => db.settings.get("google-calendar") as Promise<GoogleCalendarConfig | undefined>,
    [],
    undefined,
  );
  const undoRedo = useLiveQuery(() => getUndoRedoState(), [], {
    id: "undo-redo" as const,
    undo: [],
    redo: [],
  });
  const activeSession = sessions
    .filter(
      (session) =>
        !session.deletedAt &&
        (session.status === "running" || session.status === "paused"),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const activeTask = activeSession
    ? tasks.find((task) => task.id === activeSession.taskId)
    : undefined;
  // 止め忘れたタイマーは、大きなオーバー表示で迎えずに「おかえり」で聞く。
  const staleId = activeSession && isStale(activeSession) ? activeSession.id : null;
  useEffect(() => {
    if (staleId) setTimerVisible(false);
  }, [staleId]);
  useEffect(() => startAutoSync(), []);
  // その日最初に開いたとき：「おはよう。今日の1つ目は〇〇」
  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const key = todayKey();
        if (localStorage.getItem("sasshy-greeted") === key) return;
        localStorage.setItem("sasshy-greeted", key);
        const hour = new Date().getHours();
        const hello = hour < 11 ? "おはよう" : hour < 18 ? "こんにちは" : "おつかれさま";
        const first = (await db.tasks.toArray())
          .filter((t) => !t.deletedAt && t.status !== "done" && t.scheduledDate === key)
          .sort(compareDayFlowTasks)[0];
        window.dispatchEvent(new CustomEvent("sasshy-toast", {
          detail: first ? `${hello}。今日の1つ目は「${first.title}」` : `${hello}。今日やることを1つ入れてみよう`,
        }));
      } catch { /* storage unavailable */ }
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 完了したときの「積み上がり」など、App の外からの短いお知らせ。
  useEffect(() => {
    const show = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (!text) return;
      setActionMessage(text);
      window.setTimeout(() => setActionMessage(""), 4200);
    };
    window.addEventListener("sasshy-toast", show);
    return () => window.removeEventListener("sasshy-toast", show);
  }, []);
  // 食事の帯の「記録を見る」など、App の外からページを開く。
  useEffect(() => {
    const go = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      if (target && target in PAGE_LABEL) setPage(target as Page);
    };
    window.addEventListener("sasshy-open-page", go);
    return () => window.removeEventListener("sasshy-open-page", go);
  }, []);
  // 地図の「2分だけ」など、App の外からタスクを始める。
  useEffect(() => {
    const start = async (event: Event) => {
      const { id, ...opts } = (event as CustomEvent<{ id: string } & StartOptions>).detail || { id: "" };
      const task = id ? await db.tasks.get(id) : undefined;
      if (task) startTimerRef.current?.(task, opts);
    };
    window.addEventListener("sasshy-start-task", start);
    return () => window.removeEventListener("sasshy-start-task", start);
  }, []);
  // ルーティン開始など、App の外で始めたタイマーも画面に出す。
  useEffect(() => {
    const open = () => setTimerVisible(true);
    window.addEventListener("sasshy-open-timer", open);
    return () => window.removeEventListener("sasshy-open-timer", open);
  }, []);
  useEffect(() => subscribeSync(setSyncState), []);
  useEffect(() => {
    if (!voice) return;
    const prompts = buildCoachPlan({
      now: new Date(),
      tasks,
      activeSession,
      googleEvents: coachCalendar?.enabled ? coachCalendar.events : [],
      voice,
    });
    syncNativeCoach(
      prompts,
      voice.enabled && voice.coachEnabled !== false,
      voice.rate,
      voice.volume,
    );
  }, [tasks, activeSession, coachCalendar, voice]);
  useEffect(() => {
    const onCompleted = (event: Event) => {
      if (!voice?.enabled || voice.coachEnabled === false) return;
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (!taskId) return;
      speakVoice(completionCoachText(tasks, taskId), voice);
    };
    window.addEventListener("sasshy-task-completed", onCompleted);
    return () => window.removeEventListener("sasshy-task-completed", onCompleted);
  }, [tasks, voice]);
  // ルーティンのステップなど、習慣と同じ名前のタスクを終えたら習慣に✓。
  useEffect(() => {
    const onDone = async (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId;
      const task = taskId ? await db.tasks.get(taskId) : undefined;
      if (!task) return;
      const day = task.completedAt ? compactDate(new Date(task.completedAt)) : todayKey();
      if (await checkHabitForTask(task.title, day)) syncNow().catch(() => undefined);
    };
    window.addEventListener("sasshy-task-completed", onDone);
    return () => window.removeEventListener("sasshy-task-completed", onDone);
  }, []);
  useEffect(() => {
    if (!taskLink.hasTask) return;
    clearTaskLinkFromUrl();
    if (taskLink.error) {
      setActionMessage(taskLink.error);
      window.setTimeout(() => setActionMessage(""), 4200);
    }
  }, [taskLink]);
  useEffect(() => {
    if (page === "calendar") setTimerVisible(false);
  }, [page]);
  useEffect(() => {
    const due = memos.filter(
      (memo) =>
        !memo.deletedAt &&
        memo.reminderAt &&
        new Date(memo.reminderAt).getTime() <= Date.now() &&
        !sessionStorage.getItem(`memo-notified-${memo.id}`),
    );
    if (
      due.length &&
      "Notification" in window &&
      Notification.permission === "granted"
    )
      due.forEach((memo) => {
        new Notification(memo.title || "SASSHYメモ", {
          body: memo.body || "設定した時刻になりました",
        });
        sessionStorage.setItem(`memo-notified-${memo.id}`, "1");
      });
  }, [memos]);
  const startTimer = async (task: Task, opts: StartOptions = {}) => {
    // 寄り道・割り込みの記録は自分で始めるものではない（自動の記録専用）。
    if (task.log && !opts.interrupt) return;
    haptic("start");
    companionStart();
    playStart();
    // 直前に終えたラウンドなど、画面の情報が古いことがあるので保存先を読み直す。
    const live = activeSession ? await db.sessions.get(activeSession.id) : undefined;
    const stillActive = live && !live.deletedAt && (live.status === "running" || live.status === "paused");
    if (stillActive && activeSession?.taskId === task.id) {
      if (activeSession.status === "paused")
        await resumeFocusSession(activeSession.id);
      if (task.workStartSupport?.days[todayKey()]?.enabled)
        await recordExistingMainWork(
          task.id,
          todayKey(),
          activeSession.startedAt,
          activeSession.id,
        );
      setTimerVisible(true);
      if (voice?.enabled)
        speakVoice(
          activeSession.status === "paused"
            ? "中断していたタイマーを再開します"
            : "実行中のタイマーに戻ります",
          voice,
        );
      syncNow().catch(() => undefined);
      return;
    }
    const carriedElapsedSec = taskWorkedSeconds(task.id, sessions);
    const remainingSec = task.estimateMin * 60 - carriedElapsedSec;
    // 初めて始めるときは、同じ種類のタスクの実績（止め忘れは除く）から時間を決める。
    const usual = usualMinutes(task, sessions);
    if (voice?.enabled)
      speakVoice(
        opts.starter
          ? "2分だけやってみましょう"
          : carriedElapsedSec > 0
          ? `続きから再開します。${remainingStatusText(remainingSec)}`
          : usual.fromHistory
          ? `いつもの${usual.minutes}分でタイマーを開始します`
          : `${task.estimateMin}分タイマーを開始します`,
        voice,
      );
    if (opts.starter)
      await startFocusSession(task, starterPlannedMin(carriedElapsedSec), carriedElapsedSec, { starter: true });
    else if (opts.interrupt)
      await startFocusSession(task, task.estimateMin, carriedElapsedSec, { interrupt: opts.interrupt });
    else if (usesRounds(task)) {
      const plan = opts.plan ?? (await planSuggestions(task, null, 1))[0] ?? "";
      const next = nextRound(task, carriedElapsedSec, plan);
      const plannedMin = opts.leftMin ? Math.ceil(carriedElapsedSec / 60) + opts.leftMin : next.plannedMin;
      await startFocusSession(task, plannedMin, carriedElapsedSec, { round: next.round });
    } else if (opts.leftMin)
      await startFocusSession(task, Math.ceil(carriedElapsedSec / 60) + opts.leftMin, carriedElapsedSec);
    else await startFocusSession(task, carriedElapsedSec > 0 ? task.estimateMin : usual.minutes, carriedElapsedSec);
    setTimerVisible(true);
    syncNow().catch(() => undefined);
  };
  startTimerRef.current = startTimer;
  const reopenTimer = async () => {
    setTimerVisible(true);
    if (!activeSession || !voice?.enabled) return;
    if (activeSession.status === "paused") {
      await resumeFocusSession(activeSession.id);
      speakVoice("中断していたタイマーを再開します", voice);
    } else {
      speakVoice("タイマー画面に戻りました", voice);
    }
  };
  const runHistoryAction = async (kind: "undo" | "redo") => {
    const result =
      kind === "undo"
        ? await undoLatestTaskChange()
        : await redoLatestTaskChange();
    setActionMessage(
      result ||
        (kind === "undo"
          ? "戻せる操作はありません"
          : "やり直せる操作はありません"),
    );
    window.setTimeout(() => setActionMessage(""), 3200);
    if (result && !result.startsWith("他の端末"))
      syncNow().catch(() => undefined);
  };
  const navItems: { id: Page; icon: ReactNode }[] = [
    { id: "today", icon: <Sparkles /> },
    { id: "calendar", icon: <CalendarDays /> },
    { id: "inbox", icon: <ListTodo /> },
    { id: "map", icon: <MapIcon /> },
    { id: "records", icon: <BarChart3 /> },
    { id: "memos", icon: <MessageSquareText /> },
    { id: "history", icon: <History /> },
    { id: "settings", icon: <Settings /> },
  ];
  return (
    <div className="app-shell">
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>SASSHY</strong>
            <span>予定と集中</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => {
                setPage(item.id);
                setMenuOpen(false);
              }}
            >
              {item.icon}
              <span>{PAGE_LABEL[item.id]}</span>
              {item.id === "inbox" && (
                <small>
                  {
                    tasks.filter(
                      (task) =>
                        !task.deletedAt &&
                        !task.scheduledDate &&
                        task.status !== "done" &&
                        task.horizon === "now",
                    ).length
                  }
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className={`sync-indicator ${syncState.phase}`}>
          <span>
            {syncState.phase === "error" || syncState.phase === "offline" ? (
              <CloudOff size={16} />
            ) : (
              <Cloud size={16} />
            )}
          </span>
          <div>
            <strong>{syncState.message.split("・")[0]}</strong>
            <small>
              {syncState.message.split("・").slice(1).join("・") ||
                "端末に保存します"}
            </small>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className={`topbar${page === "calendar" ? " calendar-context" : ""}`}>
          <IconButton label="メニュー" onClick={() => setMenuOpen(!menuOpen)}>
            <Menu size={21} />
          </IconButton>
          <div className="topbar-title">
            <strong>{PAGE_LABEL[page]}</strong>
            {page === "today" && (
              <span className="topbar-date">
                {new Intl.DateTimeFormat("ja-JP", {
                  month: "numeric",
                  day: "numeric",
                  weekday: "short",
                }).format(new Date())}
                <AgeLabel />
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <button type="button" className="topbar-more" aria-label="設定を開く" onClick={() => { setMenuOpen(false); setPage("settings"); }}>
              <Settings size={19} />
            </button>
            <IconButton
              label="元に戻す"
              onClick={() => runHistoryAction("undo")}
              disabled={!undoRedo?.undo.length}
            >
              <Undo2 size={17} />
            </IconButton>
            <IconButton
              label="やり直す"
              onClick={() => runHistoryAction("redo")}
              disabled={!undoRedo?.redo.length}
            >
              <Redo2 size={17} />
            </IconButton>
            <button
              className={`top-sync ${syncState.phase}${pendingCount > 0 ? " pending" : ""}`}
              type="button"
              onClick={() => syncNow(true).catch(() => undefined)}
              title={syncState.message}
            >
              {syncState.phase === "syncing" ? (
                <TimerReset size={17} />
              ) : syncState.phase === "error" ? (
                <CloudOff size={17} />
              ) : (
                <Cloud size={17} />
              )}
              <span>
                {pendingCount > 0 && syncState.phase !== "syncing"
                  ? `未送信${pendingCount}件`
                  : syncState.phase === "ok"
                  ? "保存済み"
                  : syncState.phase === "syncing"
                    ? "同期中"
                    : "端末保存"}
              </span>
              {pendingCount > 0 && <b className="sync-badge" aria-label={`未送信${pendingCount}件`}>{pendingCount}</b>}
            </button>
          </div>
        </header>
        <div key={page} className={`view-frame page-enter${activeSession && !timerVisible && page !== "today" ? " has-timer-reopen" : ""}`}>
          {page === "today" && (
            <TodayPage
              tasks={tasks}
              sessions={sessions}
              syncState={syncState}
              onEdit={setEditing}
              onStart={startTimer}
            />
          )}
          {page === "calendar" && (
            <CalendarPage
              tasks={tasks}
              sessions={sessions}
              scheduleHistory={scheduleHistory}
              onEdit={setEditing}
              onStart={startTimer}
            />
          )}
          {page === "records" && <RecordsPanel />}
          {page === "map" && <LifeMapPanel />}
          {page === "inbox" && (
            <InboxPage tasks={tasks} onEdit={setEditing} onStart={startTimer} />
          )}
          {page === "later" && (
            <LaterPage tasks={tasks} onEdit={setEditing} onStart={startTimer} />
          )}
          {page === "memos" && (
            <MemosPage
              memos={memos.filter((memo) => !isLedgerMemo(memo) && !isDiaryMemo(memo) && !isWishMemo(memo) && !isAreaMemo(memo) && !isHabitMemo(memo))}
              onTaskCreated={(task) => {
                setPage("inbox");
                setEditing(task);
              }}
            />
          )}
          {page === "history" && (
            <HistoryPage history={history} tasks={tasks} />
          )}
          {page === "settings" && (
            <SettingsPage tasks={tasks} memos={memos} sessions={sessions} />
          )}
        </div>
      </main>
      {editing && (
        <TaskEditor
          key={editing.id}
          task={tasks.find((task) => task.id === editing.id) || editing}
          sessions={sessions}
          scheduleHistory={scheduleHistory.filter(
            (entry) => entry.taskId === editing.id,
          )}
          scheduleConflicts={scheduleOutbox.filter(
            (item) => item.taskId === editing.id && item.conflictRevision,
          )}
          onClose={() => setEditing(null)}
          onStart={startTimer}
        />
      )}
      {activeSession && voice && timerVisible && (
        <TimerDock
          key={activeSession.id}
          session={activeSession}
          task={activeTask}
          voice={activeSession.interrupt?.auto ? { ...voice, enabled: false } : voice}
          onClose={() => setTimerVisible(false)}
        />
      )}
      {activeSession && !timerVisible && !menuOpen && (
        <button
          className={`timer-reopen${page === "today" ? " on-today" : ""}`}
          type="button"
          onClick={reopenTimer}
          title={
            activeSession.status === "paused"
              ? "タイマーを再開"
              : "タイマーを表示"
          }
        >
          <Volume2 size={20} />
          <span>
            {activeSession.status === "paused"
              ? "中断中・押して再開：" + activeSession.taskTitle
              : activeSession.taskTitle}
          </span>
        </button>
      )}
      {incomingTask && (
        <TaskLinkImportDialog
          task={incomingTask}
          onClose={() => setIncomingTask(null)}
          onAdded={(created, duplicate) => {
            setIncomingTask(null);
            setPage(created.scheduledDate === todayKey() ? "today" : created.scheduledDate ? "calendar" : "inbox");
            setActionMessage(duplicate ? "このタスクは追加済みです" : `「${created.title}」を追加しました`);
            window.setTimeout(() => setActionMessage(""), 3200);
          }}
        />
      )}
      <Celebrate />
      <CompanionPopup />
      <TwoMinutePrompt />
      <StaleSessionPrompt />
      <RoundEndPrompt />
      {actionMessage && <div className="action-toast">{actionMessage}</div>}
      <nav className="mobile-nav">
        {navItems
          .filter((item) => ["today", "calendar", "inbox", "map", "records"].includes(item.id))
          .map((item) => (
          <button
            key={item.id}
            type="button"
            className={page === item.id ? "active" : ""}
            onClick={() => setPage(item.id)}
          >
            {item.icon}
            <span>{PAGE_LABEL[item.id]}</span>
          </button>
          ))}
      </nav>
      {menuOpen && mobile && (
        <button
          className="menu-scrim"
          type="button"
          aria-label="メニューを閉じる"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean; detail?: string }
> {
  state: { error: boolean; detail?: string } = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SASSHY screen error", error, info);
    // 原因を後から調べられるように、最後のエラーを端末に残す（中身はエラー文だけ）。
    try {
      localStorage.setItem("sasshy-last-error", JSON.stringify({
        at: new Date().toISOString(),
        message: String(error?.message || error),
        stack: String(error?.stack || "").slice(0, 2000),
        component: String(info?.componentStack || "").slice(0, 1500),
      }));
    } catch { /* 保存できなくても画面は出す */ }
    this.setState({ detail: String(error?.message || error) });
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-error">
          <div>
            <strong>画面を開き直してください</strong>
            <p>
              端末に保存されたタスクは消えていません。画面だけを安全に読み直します。
            </p>
            {this.state.detail && <small style={{ color: "var(--faint)", wordBreak: "break-all" }}>{this.state.detail}</small>}
            <button
              className="button primary"
              type="button"
              onClick={() => window.location.reload()}
            >
              画面を再読込
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

function AppRoot() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}

export default AppRoot;
