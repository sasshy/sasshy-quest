import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin, { Draggable } from '@fullcalendar/interaction';
import type { DateClickArg, EventDragStopArg } from '@fullcalendar/interaction';
import type { DatesSetArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import jaLocale from '@fullcalendar/core/locales/ja';
import {
  Archive, Bell, CalendarDays, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Cloud,
  CloudOff, Download, History, Inbox, ListTodo, Menu, MessageSquareText, MoreHorizontal,
  GripHorizontal, Pause, Pencil, Play, Plus, Redo2, RotateCcw, Search, Settings, SlidersHorizontal, Sparkles,
  Square, TimerReset, Trash2, Upload, Volume2, X,
  Undo2,
} from 'lucide-react';
import { db } from './db';
import {
  cloneForExport, compactDate, completeTask, createMemo, createTask, restoreHistoryEntry,
  getUndoRedoState, pauseFocusSession, redoLatestTaskChange, restoreTask, resumeFocusSession,
  softDeleteTask, startFocusSession, taskStart, todayKey, undoLatestTaskChange, updateMemo,
  updateSession, updateTask,
} from './store';
import {
  getSyncConfig, getSyncState, saveSyncConfig, setInteractionActive, startAutoSync,
  subscribeSync, syncNow, testSyncConnection, type SyncState,
} from './sync';
import { importLegacy, legacySummary, type LegacySummary } from './legacy';
import { emptyGoogleCalendar, getGoogleCalendarConfig, refreshGoogleCalendar, saveGoogleCalendarConfig } from './google-calendar';
import type { FocusSession, GoogleCalendarConfig, HistoryEntry, Memo, SyncConfig, Task, TaskHorizon, VoiceConfig } from './types';
import { announcementText, announcementThresholds, remainingStatusText, speakVoice, stopVoice } from './voice';
import { predictDuration, sessionDuration, taskActualDuration } from './insights';
import setupSql from '../supabase-setup.sql?raw';

type Page = 'today' | 'calendar' | 'inbox' | 'later' | 'memos' | 'history' | 'settings';
type CalendarMode = 'day' | 'week' | 'month';

const PAGE_LABEL: Record<Page, string> = {
  today: '今日', calendar: 'カレンダー', inbox: '受信箱', later: 'あとで', memos: 'メモ', history: '復元', settings: '設定',
};

function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const change = () => setMobile(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return mobile;
}

function formatMinute(value: number | null): string {
  if (value === null) return '';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function parseMinute(value: string): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function formatDateLabel(value: string | null): string {
  if (!value) return '日付なし';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(year, month - 1, day));
}

function shiftDate(value: string | null, amount: number): string {
  const base = value || todayKey();
  const [year, month, day] = base.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return compactDate(date);
}

function formatStamp(value: string | null): string {
  if (!value) return 'まだ同期していません';
  return new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function taskScore(task: Task): number {
  const overdue = task.scheduledDate && task.scheduledDate < todayKey() ? 8 : 0;
  return task.importance * 3 + task.urgency * 4 + overdue;
}

function IconButton({ label, onClick, children, danger = false, disabled = false }: { label: string; onClick?: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return <button className={`icon-button${danger ? ' danger' : ''}`} type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><Check size={22} /><strong>{title}</strong><span>{detail}</span></div>;
}

function QuickAdd({ defaultDate, onAdded }: { defaultDate?: string | null; onAdded?: (task: Task) => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const task = await createTask({ title, scheduledDate: defaultDate || null });
      setTitle('');
      onAdded?.(task);
      syncNow().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="quick-add" onSubmit={submit}>
      <Plus size={20} aria-hidden="true" />
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={defaultDate ? `${formatDateLabel(defaultDate)}にタスクを追加` : '思いついたことをそのまま入力'} aria-label="新しいタスク" />
      <button type="submit" disabled={!title.trim() || busy}>追加</button>
    </form>
  );
}

function PriorityMarks({ task }: { task: Task }) {
  if (!task.importance && !task.urgency) return null;
  return <span className="priority-marks">{task.importance > 0 && <span className="mark important">重要</span>}{task.urgency > 0 && <span className="mark urgent">緊急</span>}</span>;
}

function TaskRow({
  task, onEdit, onStart, compact = false, actualMin, actualReliable = true,
}: {
  task: Task;
  onEdit: (task: Task) => void;
  onStart: (task: Task) => void;
  compact?: boolean;
  actualMin?: number;
  actualReliable?: boolean;
}) {
  const done = task.status === 'done';
  const delta = actualMin === undefined ? null : actualMin - task.estimateMin;
  return (
    <div className={`task-row${done ? ' done' : ''}${compact ? ' compact' : ''}`}>
      <button className="task-check" type="button" aria-label={done ? '完了を取り消す' : '完了'} onClick={() => completeTask(task.id, !done).then(() => syncNow().catch(() => undefined))}>
        {done && <Check size={16} />}
      </button>
      <button className="task-main" type="button" onClick={() => onEdit(task)}>
        <strong>{task.title}</strong>
        <span className="task-meta">
          {task.scheduledDate && <span>{formatDateLabel(task.scheduledDate)}</span>}
          {task.startMinute !== null && <span>{formatMinute(task.startMinute)}</span>}
          <span>予測 {task.estimateMin}分</span>
          {actualMin !== undefined && <span className={`actual-chip${actualReliable ? '' : ' suspect'}`}>実績 {actualMin}分{delta ? `（${delta > 0 ? '+' : ''}${delta}分）` : ''}{actualReliable ? '' : '・要確認'}</span>}
          <PriorityMarks task={task} />
        </span>
      </button>
      {done
        ? <button className="task-reopen-action" type="button" onClick={() => completeTask(task.id, false).then(() => syncNow().catch(() => undefined))}><RotateCcw size={15} />完了取消</button>
        : <IconButton label="音声タイマーを開始" onClick={() => onStart(task)}><Play size={18} /></IconButton>}
      <IconButton label="編集" onClick={() => onEdit(task)}><Pencil size={17} /></IconButton>
    </div>
  );
}

function TaskEditor({ task, sessions, onClose, onStart }: { task: Task; sessions: FocusSession[]; onClose: () => void; onStart: (task: Task) => void }) {
  const [draft, setDraft] = useState(task);
  const [saving, setSaving] = useState(false);
  const prediction = useMemo(() => predictDuration(draft.title, sessions, task.id), [draft.title, sessions, task.id]);
  const actual = useMemo(() => taskActualDuration(task.id, sessions), [task.id, sessions]);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateTask(task.id, {
        title: draft.title.trim() || task.title,
        notes: draft.notes,
        horizon: draft.horizon,
        scheduledDate: draft.scheduledDate,
        startMinute: draft.startMinute,
        estimateMin: Math.max(5, Number(draft.estimateMin) || 25),
        durationMin: Math.max(5, Number(draft.durationMin) || Number(draft.estimateMin) || 25),
        importance: draft.importance,
        urgency: draft.urgency,
      }, 'タスク詳細を更新');
      onClose();
      syncNow().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="task-edit-title">
        <header><div><span className="eyebrow">TASK</span><h2 id="task-edit-title">タスクを編集</h2></div><IconButton label="閉じる" onClick={onClose}><X size={20} /></IconButton></header>
        <div className="form-stack">
          <label><span>タイトル</span><input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
          <label><span>メモ</span><textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} rows={4} /></label>
          <div className="form-grid">
            <div className="task-date-editor">
              <label><span>日付</span><input type="date" aria-label="日付" value={draft.scheduledDate || ''} onInput={(event) => setDraft((current) => ({ ...current, scheduledDate: event.currentTarget.value || null }))} onChange={(event) => setDraft((current) => ({ ...current, scheduledDate: event.currentTarget.value || null }))} onBlur={(event) => setDraft((current) => ({ ...current, scheduledDate: event.currentTarget.value || null }))} /></label>
              <div className="date-shortcuts" role="group" aria-label="日付の簡単変更">
                <button type="button" onClick={() => setDraft((current) => ({ ...current, scheduledDate: shiftDate(current.scheduledDate, -1) }))}>前日</button>
                <button type="button" onClick={() => setDraft((current) => ({ ...current, scheduledDate: todayKey() }))}>今日</button>
                <button type="button" onClick={() => setDraft((current) => ({ ...current, scheduledDate: shiftDate(current.scheduledDate, 1) }))}>翌日</button>
                <button type="button" onClick={() => setDraft((current) => ({ ...current, scheduledDate: null, startMinute: null }))}>日付なし</button>
              </div>
              <small>{draft.scheduledDate ? `選択中：${formatDateLabel(draft.scheduledDate)}` : '選択中：日付なし'}</small>
            </div>
            <label><span>開始時刻</span><input type="time" value={formatMinute(draft.startMinute)} onInput={(event) => setDraft((current) => ({ ...current, startMinute: parseMinute(event.currentTarget.value) }))} onChange={(event) => setDraft((current) => ({ ...current, startMinute: parseMinute(event.currentTarget.value) }))} /></label>
            <label><span>予定時間</span><input type="number" min="5" step="5" value={draft.estimateMin} onChange={(event) => setDraft((current) => ({ ...current, estimateMin: Number(event.target.value) }))} /></label>
            <label><span>置き場所</span><select value={draft.horizon} onChange={(event) => setDraft((current) => ({ ...current, horizon: event.target.value as TaskHorizon }))}><option value="now">今やる</option><option value="someday">いつか</option><option value="wish">やりたい</option><option value="waiting">待ち</option></select></label>
            <label><span>重要度</span><select value={draft.importance} onChange={(event) => setDraft((current) => ({ ...current, importance: Number(event.target.value) as 0 | 1 | 2 }))}><option value="0">指定なし</option><option value="1">重要</option><option value="2">最重要</option></select></label>
            <label><span>緊急度</span><select value={draft.urgency} onChange={(event) => setDraft((current) => ({ ...current, urgency: Number(event.target.value) as 0 | 1 | 2 }))}><option value="0">指定なし</option><option value="1">緊急</option><option value="2">最緊急</option></select></label>
          </div>
          {(actual || prediction) && <div className="duration-insight">
            <div>
              {actual && <strong>今回の実績 {actual.activeMin}分{actual.reliable ? '' : '（押し忘れの可能性・予測から除外）'}</strong>}
              {prediction && <span>次回予測 {prediction.predictedMin}分・過去{prediction.sampleSize}回の中央値{prediction.ignoredCount ? `（長すぎる記録${prediction.ignoredCount}件を除外）` : ''}</span>}
            </div>
            {prediction && prediction.predictedMin !== draft.estimateMin && <button type="button" onClick={() => setDraft((current) => ({ ...current, estimateMin: prediction.predictedMin, durationMin: prediction.predictedMin }))}>予測を使う</button>}
          </div>}
        </div>
        <footer className="modal-actions">
          <button className="button danger-quiet" type="button" disabled={saving} onClick={async () => { await softDeleteTask(task.id); onClose(); syncNow().catch(() => undefined); }}><Trash2 size={17} />ゴミ箱へ</button>
          {task.status === 'done' && <button className="button secondary" type="button" disabled={saving} onClick={async () => { await completeTask(task.id, false); onClose(); syncNow().catch(() => undefined); }}><RotateCcw size={16} />完了取消</button>}
          <span className="spacer" />
          {task.status !== 'done' && <button className="button secondary" type="button" disabled={saving} onClick={() => { onClose(); onStart(draft); }}><Play size={17} />タイマー</button>}
          <button className="button primary" type="button" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </section>
    </div>
  );
}

function TodayPage({ tasks, sessions, onEdit, onStart }: { tasks: Task[]; sessions: FocusSession[]; onEdit: (task: Task) => void; onStart: (task: Task) => void }) {
  const today = todayKey();
  const due = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && task.scheduledDate === today).sort((a, b) => (a.startMinute ?? 9999) - (b.startMinute ?? 9999));
  const overdue = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && task.scheduledDate && task.scheduledDate < today).sort((a, b) => taskScore(b) - taskScore(a));
  const inbox = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && !task.scheduledDate && task.horizon === 'now').sort((a, b) => taskScore(b) - taskScore(a));
  const completedToday = tasks
    .filter((task) => !task.deletedAt && task.status === 'done' && task.completedAt && compactDate(new Date(task.completedAt)) === today)
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  const focus = [...due, ...overdue, ...inbox][0];
  return (
    <div className="page-content today-page">
      <QuickAdd defaultDate={today} />
      <section className="focus-band">
        <div><span className="eyebrow">NOW</span><h2>今やる</h2></div>
        {focus ? <div className="focus-task"><div><strong>{focus.title}</strong><span>{focus.estimateMin}分だけ、ここから始める</span></div><button className="start-button" type="button" onClick={() => onStart(focus)}><Play size={22} fill="currentColor" />開始</button></div> : <EmptyState title="いまは空です" detail="今日のタスクを追加すると、ここに1件だけ出します" />}
      </section>
      {overdue.length > 0 && <section className="task-section overdue-section"><header><div><span className="section-kicker">持ち越し</span><h2>過ぎた予定</h2></div><span>{overdue.length}件</span></header><div className="task-list">{overdue.map((task) => <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} />)}</div></section>}
      <section className="task-section"><header><div><span className="section-kicker">TODAY</span><h2>今日の予定</h2></div><span>{due.length}件</span></header>{due.length ? <div className="task-list">{due.map((task) => <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} />)}</div> : <EmptyState title="予定はまだありません" detail="上の入力欄から、今日やることを追加できます" />}</section>
      {completedToday.length > 0 && <section className="task-section completed-section"><header><div><span className="section-kicker">DONE TODAY</span><h2>今日完了</h2><p>完了取消と、予測・実績の差をここで確認できます。</p></div><span>{completedToday.length}件</span></header><div className="task-list">{completedToday.map((task) => { const actual = taskActualDuration(task.id, sessions); return <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} actualMin={actual?.activeMin} actualReliable={actual?.reliable} />; })}</div></section>}
      <section className="task-section"><header><div><span className="section-kicker">INBOX</span><h2>日付なし</h2></div><span>{inbox.length}件</span></header>{inbox.length ? <div className="task-list">{inbox.slice(0, 8).map((task) => <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} compact />)}</div> : <EmptyState title="受信箱は空です" detail="思いつきを忘れず捕まえられています" />}</section>
    </div>
  );
}

function CalendarPage({ tasks, sessions, onEdit, onStart }: { tasks: Task[]; sessions: FocusSession[]; onEdit: (task: Task) => void; onStart: (task: Task) => void }) {
  const calendarRef = useRef<FullCalendar>(null);
  const backlogRef = useRef<HTMLDivElement>(null);
  const calendarSurfaceRef = useRef<HTMLElement>(null);
  const edgeMoveRef = useRef<{ taskId: string; direction: -1 | 1 } | null>(null);
  const [mode, setMode] = useState<CalendarMode>('week');
  const [title, setTitle] = useState('');
  const [activeDate, setActiveDate] = useState(todayKey());
  const [search, setSearch] = useState('');
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const ignoreEventClickUntil = useRef(0);
  const googleCalendar = useLiveQuery(() => getGoogleCalendarConfig(), [], emptyGoogleCalendar) || emptyGoogleCalendar;
  const unscheduled = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && !task.scheduledDate && task.horizon === 'now' && task.title.toLowerCase().includes(search.toLowerCase()));
  const events = useMemo<EventInput[]>(() => tasks.filter((task) => !task.deletedAt && task.scheduledDate).map((task) => {
    const start = taskStart(task)!;
    const allDay = task.startMinute === null;
    const end = allDay ? undefined : new Date(start.getTime() + task.durationMin * 60_000);
    return {
      id: task.id,
      title: task.title,
      start,
      end,
      allDay,
      editable: true,
      durationEditable: !allDay,
      classNames: [`task-event`, task.status === 'done' ? 'is-done' : '', task.importance ? 'is-important' : ''].filter(Boolean),
      extendedProps: { taskId: task.id },
    };
  }), [tasks]);
  const actualEvents = useMemo<EventInput[]>(() => {
    const completedSessions: EventInput[] = sessions
      .filter((session) => session.status === 'completed' && session.endedAt)
      .flatMap((session) => {
        const task = tasks.find((item) => item.id === session.taskId);
        if (!task || task.deletedAt || !session.endedAt) return [];
        const actual = sessionDuration(session);
        if (!actual) return [];
        const endedAt = new Date(session.endedAt);
        const visibleMinutes = actual.reliable ? actual.wallMin : Math.min(60, Math.max(5, session.plannedMin));
        const startedAt = actual.reliable ? new Date(session.startedAt) : new Date(endedAt.getTime() - visibleMinutes * 60_000);
        return [{
          id: `actual:${session.id}`,
          title: `実績 ${actual.activeMin}分${actual.reliable ? '' : '・要確認'} · ${task.title}`,
          start: startedAt,
          end: endedAt,
          allDay: false,
          editable: false,
          durationEditable: false,
          classNames: ['actual-event', actual.reliable ? '' : 'is-suspect'].filter(Boolean),
          extendedProps: { taskId: task.id, actualSession: true },
        } satisfies EventInput];
      });
    const taskIdsWithSessions = new Set(sessions.filter((session) => session.status === 'completed').map((session) => session.taskId));
    const manualCompletions = tasks
      .filter((task) => !task.deletedAt && task.status === 'done' && task.completedAt && !taskIdsWithSessions.has(task.id))
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
          classNames: ['manual-completion-event'],
          extendedProps: { taskId: task.id, manualCompletion: true },
        } satisfies EventInput;
      });
    return [...completedSessions, ...manualCompletions];
  }, [sessions, tasks]);
  const calendarEvents = useMemo<EventInput[]>(() => [
    ...events,
    ...actualEvents,
    ...(googleCalendar.enabled ? googleCalendar.events.map((event) => ({
      id: `google:${event.id}`,
      title: `${event.calendarName ? `${event.calendarName}・` : ''}${event.title}`,
      start: event.start,
      end: event.end || undefined,
      allDay: event.allDay,
      editable: false,
      classNames: ['google-event'],
      backgroundColor: event.color || undefined,
      borderColor: event.color || undefined,
      extendedProps: { googleCalendar: true },
    })) : []),
  ], [actualEvents, events, googleCalendar]);

  useEffect(() => {
    const last = googleCalendar.lastSyncAt ? new Date(googleCalendar.lastSyncAt).getTime() : 0;
    if (googleCalendar.enabled && googleCalendar.feedUrl && Date.now() - last > 15 * 60_000) refreshGoogleCalendar(googleCalendar).catch(() => undefined);
  }, [googleCalendar.enabled, googleCalendar.feedUrl, googleCalendar.lastSyncAt]);

  useEffect(() => {
    if (!backlogRef.current) return;
    const draggable = new Draggable(backlogRef.current, {
      itemSelector: '.backlog-card',
      eventData: (element) => ({ id: element.dataset.taskId, title: element.dataset.title, duration: { minutes: Number(element.dataset.duration) || 25 } }),
    });
    return () => draggable.destroy();
  }, [unscheduled.length]);

  const viewFor = (nextMode: CalendarMode) => nextMode === 'day' ? 'timeGridDay' : nextMode === 'month' ? 'dayGridMonth' : 'timeGridWeek';
  const changeMode = (nextMode: CalendarMode) => {
    setMode(nextMode);
    calendarRef.current?.getApi().changeView(viewFor(nextMode));
  };

  const saveEventDate = async (taskId: string, start: Date | null, end: Date | null, allDay: boolean, label: string) => {
    if (!start) return;
    const durationMin = end ? Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000)) : undefined;
    await updateTask(taskId, {
      scheduledDate: compactDate(start),
      startMinute: allDay ? null : start.getHours() * 60 + start.getMinutes(),
      ...(durationMin ? { durationMin, estimateMin: durationMin } : {}),
    }, label);
    syncNow().catch(() => undefined);
  };

  const beginDurationResize = (pointer: ReactPointerEvent<HTMLSpanElement>, taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    const eventElement = pointer.currentTarget.closest<HTMLElement>('.fc-timegrid-event');
    const slotElement = eventElement?.closest('.fc-timegrid')?.querySelector<HTMLElement>('.fc-timegrid-slot-lane');
    if (!task || !eventElement || !slotElement) return;

    pointer.preventDefault();
    pointer.stopPropagation();
    const handle = pointer.currentTarget;
    const pointerId = pointer.pointerId;
    const startY = pointer.clientY;
    const startHeight = eventElement.getBoundingClientRect().height;
    const startDuration = Math.max(5, task.durationMin);
    const slotHeight = Math.max(1, slotElement.getBoundingClientRect().height);
    let nextDuration = startDuration;
    let moved = false;
    setInteractionActive(true);
    document.body.classList.add('calendar-resizing');
    handle.setPointerCapture?.(pointerId);
    handle.dataset.duration = `${startDuration}分`;

    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const deltaMinutes = Math.round((((event.clientY - startY) / slotHeight) * 15) / 5) * 5;
      nextDuration = Math.max(5, Math.min(720, startDuration + deltaMinutes));
      moved ||= Math.abs(event.clientY - startY) > 3;
      eventElement.style.height = `${Math.max(12, startHeight + ((nextDuration - startDuration) / 15) * slotHeight)}px`;
      handle.dataset.duration = `${nextDuration}分`;
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      handle.releasePointerCapture?.(pointerId);
      document.body.classList.remove('calendar-resizing');
      eventElement.style.height = '';
      delete handle.dataset.duration;
      setInteractionActive(false);
      if (!moved || nextDuration === startDuration) return;
      ignoreEventClickUntil.current = Date.now() + 600;
      updateTask(taskId, { durationMin: nextDuration, estimateMin: nextDuration }, 'カレンダーで時間を変更')
        .then(() => syncNow().catch(() => undefined));
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const moveToAdjacentPeriod = async (taskId: string, direction: -1 | 1) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task?.scheduledDate) return;
    const [year, month, day] = task.scheduledDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (mode === 'month') {
      const targetMonth = date.getMonth() + direction;
      const target = new Date(date.getFullYear(), targetMonth, 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      date.setFullYear(target.getFullYear(), target.getMonth(), Math.min(day, lastDay));
    } else date.setDate(date.getDate() + direction * (mode === 'week' ? 7 : 1));
    await updateTask(taskId, { scheduledDate: compactDate(date) }, `カレンダーで${direction < 0 ? '前' : '次'}の期間へ移動`);
    direction < 0 ? calendarRef.current?.getApi().prev() : calendarRef.current?.getApi().next();
    syncNow().catch(() => undefined);
  };

  const finishEventDrag = (info: EventDragStopArg) => {
    setInteractionActive(false);
    setDraggingTaskId(null);
    const rect = calendarSurfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const edgeSize = Math.min(64, rect.width * .18);
    const direction: -1 | 1 | null = info.jsEvent.clientX <= rect.left + edgeSize ? -1 : info.jsEvent.clientX >= rect.right - edgeSize ? 1 : null;
    if (!direction) return;
    edgeMoveRef.current = { taskId: info.event.id, direction };
    ignoreEventClickUntil.current = Date.now() + 800;
    moveToAdjacentPeriod(info.event.id, direction).catch(() => undefined);
    window.setTimeout(() => { edgeMoveRef.current = null; }, 0);
  };

  return (
    <div className={`calendar-page mode-${mode}`}>
      <div className="calendar-toolbar">
        <div className="calendar-nav"><IconButton label="前へ" onClick={() => calendarRef.current?.getApi().prev()}><ChevronLeft size={19} /></IconButton><button className="button today-button" type="button" onClick={() => calendarRef.current?.getApi().today()}>今日</button><IconButton label="次へ" onClick={() => calendarRef.current?.getApi().next()}><ChevronRight size={19} /></IconButton><strong>{title}</strong></div>
        <div className="segmented" aria-label="カレンダー表示">{(['day', 'week', 'month'] as CalendarMode[]).map((item) => <button key={item} type="button" className={mode === item ? 'active' : ''} onClick={() => changeMode(item)}>{item === 'day' ? '日' : item === 'week' ? '週' : '月'}</button>)}</div>
      </div>
      <div className="calendar-layout">
        <aside className="backlog-panel">
          <header><div><span className="section-kicker">UNSCHEDULED</span><h2>日付なし</h2></div><span>{unscheduled.length}</span></header>
          <div className="backlog-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="絞り込み" /></div>
          <QuickAdd defaultDate={null} />
          <div ref={backlogRef} className="backlog-list">{unscheduled.map((task) => <div key={task.id} className="backlog-card" data-task-id={task.id} data-title={task.title} data-duration={task.estimateMin}><button type="button" onClick={() => onEdit(task)}><strong>{task.title}</strong><span>{task.estimateMin}分</span></button><IconButton label="タイマー" onClick={() => onStart(task)}><Play size={16} /></IconButton></div>)}</div>
        </aside>
        <section className="calendar-surface" ref={calendarSurfaceRef}>
          {draggingTaskId && <><div className="calendar-edge-drop previous"><ChevronLeft size={20} /><span>{mode === 'day' ? '前の日' : mode === 'week' ? '前の週' : '前の月'}</span></div><div className="calendar-edge-drop next"><span>{mode === 'day' ? '次の日' : mode === 'week' ? '次の週' : '次の月'}</span><ChevronRight size={20} /></div></>}
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            locale={jaLocale}
            initialView={viewFor(mode)}
            headerToolbar={false}
            firstDay={1}
            nowIndicator
            editable
            selectable
            droppable
            eventResizableFromStart
            allDaySlot
            allDayText="時刻なし"
            slotMinTime="06:00:00"
            slotMaxTime="25:00:00"
            slotDuration="00:15:00"
            snapDuration="00:05:00"
            scrollTime="08:00:00"
            height="100%"
            dayMaxEvents={4}
            events={calendarEvents}
            datesSet={(info: DatesSetArg) => { setTitle(info.view.title); setActiveDate(compactDate(info.start)); }}
            dateClick={(info: DateClickArg) => createTask({ title: '新しいタスク', scheduledDate: info.dateStr.slice(0, 10), startMinute: info.allDay ? null : info.date.getHours() * 60 + info.date.getMinutes() }).then(onEdit)}
            select={(info) => createTask({ title: '新しいタスク', scheduledDate: compactDate(info.start), startMinute: info.allDay ? null : info.start.getHours() * 60 + info.start.getMinutes(), durationMin: info.end ? Math.max(5, Math.round((info.end.getTime() - info.start.getTime()) / 60_000)) : 25 }).then(onEdit)}
            eventContent={(info) => {
              const taskId = info.event.extendedProps.taskId || info.event.id;
              const task = tasks.find((item) => item.id === taskId);
              const readOnlyActual = info.event.extendedProps.actualSession || info.event.extendedProps.manualCompletion;
              return <div className="calendar-event-content"><div className="calendar-event-copy">{info.timeText && <b>{info.timeText}</b>}<span>{info.event.title}</span></div>{task && !readOnlyActual && !info.event.allDay && info.view.type.startsWith('timeGrid') && <span className="task-resize-grip" role="separator" aria-label={`${task.title}の時間を変更`} title="上下にドラッグして時間を変更" onPointerDown={(event) => beginDurationResize(event, task.id)}><GripHorizontal size={15} /></span>}</div>;
            }}
            eventClick={(info: EventClickArg) => { if (Date.now() < ignoreEventClickUntil.current) return; const taskId = info.event.extendedProps.taskId || info.event.id; const task = tasks.find((item) => item.id === taskId); if (task) onEdit(task); }}
            eventDragStart={(info) => { setInteractionActive(true); setDraggingTaskId(info.event.id); }}
            eventDragStop={finishEventDrag}
            eventResizeStart={() => setInteractionActive(true)}
            eventResizeStop={() => setInteractionActive(false)}
            eventDrop={(info: EventDropArg) => { const edge = edgeMoveRef.current; if (edge?.taskId === info.event.id) { info.revert(); return; } saveEventDate(info.event.id, info.event.start, info.event.end, info.event.allDay, 'カレンダーで予定を移動'); }}
            eventResize={(info) => saveEventDate(info.event.id, info.event.start, info.event.end, info.event.allDay, 'カレンダーで時間を変更')}
            eventReceive={(info) => { setInteractionActive(false); saveEventDate(info.event.id, info.event.start, info.event.end, info.event.allDay, '日付なしからカレンダーへ移動'); info.event.remove(); }}
            eventClassNames={(arg) => arg.event.extendedProps.taskId ? [] : ['external-event']}
          />
          <div className="calendar-mobile-add"><QuickAdd defaultDate={mode === 'day' ? activeDate : todayKey()} /></div>
        </section>
      </div>
    </div>
  );
}

function InboxPage({ tasks, onEdit, onStart }: { tasks: Task[]; onEdit: (task: Task) => void; onStart: (task: Task) => void }) {
  const inbox = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && !task.scheduledDate && task.horizon === 'now').sort((a, b) => taskScore(b) - taskScore(a));
  return <div className="page-content"><QuickAdd /><section className="task-section page-section"><header><div><span className="section-kicker">CAPTURE FIRST</span><h2>受信箱</h2><p>整理はあとで大丈夫。思いつきをここに置きます。</p></div><span>{inbox.length}件</span></header>{inbox.length ? <div className="task-list">{inbox.map((task) => <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} />)}</div> : <EmptyState title="受信箱は空です" detail="頭の中の気になることを、上からそのまま入力できます" />}</section></div>;
}

function LaterPage({ tasks, onEdit, onStart }: { tasks: Task[]; onEdit: (task: Task) => void; onStart: (task: Task) => void }) {
  const groups: { key: TaskHorizon; label: string; hint: string }[] = [{ key: 'someday', label: 'いつか', hint: '今週ではないけれど残しておく' }, { key: 'wish', label: 'やりたい', hint: '義務ではないアイデア' }, { key: 'waiting', label: '待ち', hint: '返事や到着を待っている' }];
  return <div className="page-content"><section className="later-grid">{groups.map((group) => { const items = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && task.horizon === group.key); return <div className="later-column" key={group.key}><header><div><h2>{group.label}</h2><p>{group.hint}</p></div><span>{items.length}</span></header><button className="inline-add" type="button" onClick={() => createTask({ title: '新しいタスク', horizon: group.key }).then(onEdit)}><Plus size={17} />追加</button><div className="task-list">{items.map((task) => <TaskRow key={task.id} task={task} onEdit={onEdit} onStart={onStart} compact />)}</div></div>; })}</section></div>;
}

function MemosPage({ memos, onTaskCreated }: { memos: Memo[]; onTaskCreated: (task: Task) => void }) {
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reminderAt, setReminderAt] = useState('');
  const visible = memos.filter((memo) => !memo.deletedAt && !memo.archived && `${memo.title} ${memo.body}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() && !body.trim()) return;
    await createMemo({ title, body, reminderAt: reminderAt ? new Date(reminderAt).toISOString() : null });
    setTitle(''); setBody(''); setReminderAt(''); syncNow().catch(() => undefined);
  };
  return <div className="page-content memo-page"><form className="memo-compose" onSubmit={add}><div><span className="section-kicker">PERSISTENT MEMO</span><h2>消えないメモ</h2></div><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="タイトル（省略可）" /><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="覚えておきたいこと" rows={4} /><div className="memo-compose-footer"><label><Bell size={16} /><input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} /></label><button className="button primary" type="submit">保存</button></div></form><div className="memo-filter"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="メモを検索" /><span>{visible.length}件</span></div><div className="memo-grid">{visible.map((memo) => <article className="memo-card" key={memo.id}><header><span>{memo.category}</span><button type="button" className={memo.pinned ? 'pin active' : 'pin'} onClick={() => updateMemo(memo.id, { pinned: !memo.pinned }, memo.pinned ? 'ピンを外す' : 'ピン留め')}>PIN</button></header>{memo.title && <h3>{memo.title}</h3>}<p>{memo.body}</p>{memo.reminderAt && <div className="memo-reminder"><Bell size={15} />{formatStamp(memo.reminderAt)}</div>}<footer><button type="button" onClick={() => createTask({ title: memo.title || memo.body.slice(0, 40), notes: memo.body }).then(onTaskCreated)}><ListTodo size={16} />タスク化</button><button type="button" onClick={() => updateMemo(memo.id, { archived: true }, 'メモをアーカイブ')}><Archive size={16} />保管</button></footer></article>)}</div></div>;
}

function HistoryPage({ history, tasks }: { history: HistoryEntry[]; tasks: Task[] }) {
  const trash = tasks.filter((task) => task.deletedAt).sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  const completed = tasks.filter((task) => !task.deletedAt && task.status === 'done').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 30);
  const restoreAndSync = async (action: () => Promise<unknown>) => {
    await action();
    syncNow().catch(() => undefined);
  };
  return (
    <div className="page-content history-page">
      <div className="recovery-column">
        <section className="task-section page-section">
          <header><div><span className="section-kicker">COMPLETED</span><h2>完了済み</h2><p>間違って完了したタスクを戻せます。</p></div><span>{completed.length}件</span></header>
          {completed.length ? <div className="recovery-list">{completed.map((task) => <div key={task.id}><div><strong>{task.title}</strong><span>{formatStamp(task.completedAt)}</span></div><button className="button secondary" type="button" onClick={() => restoreAndSync(() => completeTask(task.id, false))}><RotateCcw size={16} />完了取消</button></div>)}</div> : <EmptyState title="完了済みはありません" detail="完了したタスクがここに並びます" />}
        </section>
        <section className="task-section page-section">
          <header><div><span className="section-kicker">TRASH</span><h2>ゴミ箱</h2><p>削除したタスクもここから戻せます。</p></div><span>{trash.length}件</span></header>
          {trash.length ? <div className="trash-list">{trash.map((task) => <div key={task.id}><div><strong>{task.title}</strong><span>{formatStamp(task.deletedAt)}</span></div><button className="button secondary" type="button" onClick={() => restoreAndSync(() => restoreTask(task.id))}><RotateCcw size={16} />復元</button></div>)}</div> : <EmptyState title="ゴミ箱は空です" detail="削除操作でデータが即座に消えることはありません" />}
        </section>
      </div>
      <section className="task-section page-section">
        <header><div><span className="section-kicker">CHANGE LOG</span><h2>変更履歴</h2><p>1件ずつ、変更前の状態へ戻せます。</p></div><span>最新{Math.min(history.length, 100)}件</span></header>
        <div className="history-list">{history.slice(0, 100).map((entry) => <div key={entry.id}><div className="history-dot" /><div><strong>{entry.label}</strong><span>{formatStamp(entry.createdAt)}・{entry.source === 'remote' ? '他の端末' : entry.source === 'import' ? '旧版取込' : 'この端末'}</span></div>{entry.entityType === 'task' && entry.before ? <button type="button" onClick={() => restoreAndSync(() => restoreHistoryEntry(entry))}><RotateCcw size={16} />この前へ戻す</button> : null}</div>)}</div>
      </section>
    </div>
  );
}

function SettingsPage({ tasks, memos, sessions }: { tasks: Task[]; memos: Memo[]; sessions: FocusSession[] }) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [googleCalendar, setGoogleCalendar] = useState<GoogleCalendarConfig | null>(null);
  const [legacy, setLegacy] = useState<LegacySummary | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getSyncConfig().then(setConfig);
    db.settings.get('voice').then((value) => setVoiceConfig(value as unknown as VoiceConfig));
    getGoogleCalendarConfig().then(setGoogleCalendar);
    legacySummary().then(setLegacy);
  }, [tasks.length, memos.length]);
  if (!config || !voiceConfig || !googleCalendar) return null;
  const perform = async (work: () => Promise<unknown>, success: string) => { setBusy(true); setMessage(''); try { await work(); setMessage(success); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const save = async () => { const next = await saveSyncConfig(config); setConfig(next); };
  const exportData = async () => {
    const payload = cloneForExport({ version: 2, exportedAt: new Date().toISOString(), tasks: await db.tasks.toArray(), memos: await db.memos.toArray(), sessions: await db.sessions.toArray(), history: await db.history.toArray() });
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sasshy-v2-backup-${todayKey()}.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="page-content settings-page"><section className="settings-section"><header><Cloud size={20} /><div><h2>Mac・iPhone同期</h2><p>タスク、メモ、作業記録を1件ずつ同期します。</p></div></header><div className="sync-safety-note"><Check size={18} /><span>同期に失敗しても、この端末のデータは消しません。古い端末が全体を上書きすることもありません。</span></div><div className="form-stack"><label><span>Supabase URL</span><input value={config.url} onChange={(event) => setConfig({ ...config, url: event.target.value })} placeholder="https://xxxxx.supabase.co" /></label><label><span>API key（publishable）</span><input type="password" value={config.apiKey} onChange={(event) => setConfig({ ...config, apiKey: event.target.value })} /></label><label><span>同期キー</span><input value={config.syncKey} onChange={(event) => setConfig({ ...config, syncKey: event.target.value })} /></label><label className="toggle-row"><span><strong>自動同期</strong><small>30秒ごと・画面復帰時</small></span><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.target.checked })} /></label></div><div className="button-row"><button className="button primary" type="button" onClick={() => perform(async () => { await save(); await testSyncConnection(config); }, '接続できました')} disabled={busy}>設定保存・接続確認</button><button className="button secondary" type="button" onClick={() => perform(async () => { await save(); await syncNow(true); }, '安全同期が完了しました')} disabled={busy}><Cloud size={17} />今すぐ同期</button><button className="button secondary" type="button" onClick={() => navigator.clipboard.writeText(setupSql).then(() => setMessage('Supabase SQLをコピーしました'))}>初期化SQLをコピー</button></div>{message && <p className="settings-message">{message}</p>}</section><section className="settings-section"><header><CalendarDays size={20} /><div><h2>Googleカレンダー</h2><p>予定を読み込み専用で重ねます。SASSHYからGoogle側は変更しません。</p></div></header><div className="form-stack"><label><span>Apps Script WebアプリURL</span><input value={googleCalendar.feedUrl} onChange={(event) => setGoogleCalendar({ ...googleCalendar, feedUrl: event.target.value })} placeholder="https://script.google.com/macros/s/.../exec?token=..." /></label><label className="toggle-row"><span><strong>カレンダーに表示</strong><small>{googleCalendar.events.length}件・最終更新 {formatStamp(googleCalendar.lastSyncAt)}</small></span><input type="checkbox" checked={googleCalendar.enabled} onChange={(event) => setGoogleCalendar({ ...googleCalendar, enabled: event.target.checked })} /></label></div><div className="button-row"><button className="button primary" type="button" disabled={busy} onClick={() => perform(async () => { await saveGoogleCalendarConfig(googleCalendar); const next = await refreshGoogleCalendar(googleCalendar); setGoogleCalendar(next); }, 'Googleカレンダーを更新しました')}>読み込み・更新</button><button className="button secondary" type="button" onClick={() => perform(async () => saveGoogleCalendarConfig(googleCalendar), '表示設定を保存しました')}>設定だけ保存</button></div>{googleCalendar.lastError && <p className="settings-error">{googleCalendar.lastError}</p>}</section><section className="settings-section"><header><SlidersHorizontal size={20} /><div><h2>音声タイマー・通知</h2><p>読み上げる時点と声の速さを調整します。</p></div></header><div className="form-stack"><label className="toggle-row"><span><strong>音声案内</strong><small>残り時間を日本語で読み上げます</small></span><input type="checkbox" checked={voiceConfig.enabled} onChange={(event) => setVoiceConfig({ ...voiceConfig, enabled: event.target.checked })} /></label><label className="toggle-row"><span><strong>1分ごとの時間案内</strong><small>開始後、残り1分まで毎分読み上げます</small></span><input type="checkbox" checked={voiceConfig.everyMinute !== false} onChange={(event) => setVoiceConfig({ ...voiceConfig, everyMinute: event.target.checked })} /></label><label className="toggle-row"><span><strong>終了前カウント</strong><small>30秒・10秒・5秒から1秒まで読み上げます</small></span><input type="checkbox" checked={voiceConfig.finalCountdown !== false} onChange={(event) => setVoiceConfig({ ...voiceConfig, finalCountdown: event.target.checked })} /></label><label><span>追加で読み上げる残り時間（分、カンマ区切り）</span><input value={voiceConfig.announcements.join(', ')} onChange={(event) => setVoiceConfig({ ...voiceConfig, announcements: event.target.value.split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a) })} /></label><div className="range-grid"><label><span>速さ {voiceConfig.rate.toFixed(1)}</span><input type="range" min="0.6" max="1.6" step="0.1" value={voiceConfig.rate} onChange={(event) => setVoiceConfig({ ...voiceConfig, rate: Number(event.target.value) })} /></label><label><span>音量 {Math.round(voiceConfig.volume * 100)}%</span><input type="range" min="0" max="1" step="0.1" value={voiceConfig.volume} onChange={(event) => setVoiceConfig({ ...voiceConfig, volume: Number(event.target.value) })} /></label></div></div><div className="button-row"><button className="button primary" type="button" onClick={() => perform(async () => db.settings.put({ id: 'voice', enabled: voiceConfig.enabled, rate: voiceConfig.rate, volume: voiceConfig.volume, announcements: voiceConfig.announcements, everyMinute: voiceConfig.everyMinute !== false, finalCountdown: voiceConfig.finalCountdown !== false }), '音声設定を保存しました')}>音声設定を保存</button><button className="button secondary" type="button" onClick={() => perform(async () => { if (!speakVoice('音声案内のテストです', { ...voiceConfig, enabled: true })) throw new Error('このブラウザでは音声を再生できません'); }, 'テスト音声を再生しました')}><Volume2 size={17} />音声テスト</button><button className="button secondary" type="button" onClick={() => perform(async () => { if (!('Notification' in window)) throw new Error('このブラウザは通知に対応していません'); const permission = await Notification.requestPermission(); if (permission !== 'granted') throw new Error('通知が許可されませんでした'); }, '通知を許可しました')}><Bell size={17} />通知を許可</button></div></section><section className="settings-section"><header><Upload size={20} /><div><h2>旧版から移行</h2><p>旧版は変更せず、v2へコピーします。</p></div></header>{legacy?.available ? <div className="migration-box"><div><strong>旧版：タスク{legacy.tasks}件・メモ{legacy.memos}件</strong><span>取込済み：タスク{legacy.alreadyImportedTasks}件・メモ{legacy.alreadyImportedMemos}件</span></div><button className="button primary" type="button" disabled={busy} onClick={() => perform(async () => { const result = await importLegacy(); await syncNow().catch(() => undefined); setLegacy(await legacySummary()); return result; }, '旧版データをコピーしました')}>未取込分をコピー</button></div> : <p className="muted">この端末・このURLには旧版のデータが見つかりません。</p>}</section><section className="settings-section"><header><Download size={20} /><div><h2>バックアップ</h2><p>現在の状態と履歴をJSONで保存します。</p></div></header><div className="data-summary"><span>タスク<strong>{tasks.length}</strong></span><span>メモ<strong>{memos.length}</strong></span><span>作業記録<strong>{sessions.length}</strong></span></div><button className="button secondary" type="button" onClick={exportData}><Download size={17} />バックアップを書き出す</button></section></div>;
}

function TimerDock({ session, task, voice, onClose }: { session: FocusSession; task?: Task; voice: VoiceConfig; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  const announced = useRef(new Set<number>());
  const previous = useRef<number | null>(null);
  const paused = session.status === 'paused';
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    if ('wakeLock' in navigator && session.status === 'running') (navigator as Navigator & { wakeLock: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen').then((value) => { lock = value; }).catch(() => undefined);
    return () => { lock?.release().catch(() => undefined); };
  }, [session.status]);
  const remainingAt = (at: number) => {
    const start = new Date(session.startedAt).getTime();
    const pauseExtra = paused && session.pausedAt ? Math.max(0, at - new Date(session.pausedAt).getTime()) : 0;
    const elapsedSec = Math.max(0, Math.floor((at - start - session.pausedTotalSec * 1000 - pauseExtra) / 1000));
    return session.plannedMin * 60 - elapsedSec;
  };
  const remainingSec = remainingAt(now);
  useEffect(() => {
    if (!voice.enabled || paused || remainingSec < 0) { previous.current = remainingSec; return; }
    for (const threshold of announcementThresholds(voice, session.plannedMin)) {
      if (previous.current !== null && previous.current > threshold && remainingSec <= threshold && !announced.current.has(threshold)) {
        speakVoice(announcementText(threshold), voice);
        announced.current.add(threshold);
      }
    }
    if (previous.current !== null && previous.current > 0 && remainingSec <= 0) {
      speakVoice('予定時間になりました', voice);
    }
    previous.current = remainingSec;
  }, [remainingSec, paused, voice]);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        stopVoice();
        previous.current = null;
        return;
      }
      const current = remainingAt(Date.now());
      setNow(Date.now());
      previous.current = current;
      if (!paused && voice.enabled) speakVoice(`タイマーに戻りました。${remainingStatusText(current)}`, voice);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [paused, session.startedAt, session.pausedAt, session.pausedTotalSec, session.plannedMin, voice]);
  const display = Math.abs(remainingSec);
  const time = `${String(Math.floor(display / 60)).padStart(2, '0')}:${String(display % 60).padStart(2, '0')}`;
  const pauseToggle = async () => {
    if (paused) {
      const resumed = await resumeFocusSession(session.id);
      if (resumed && voice.enabled) speakVoice(`タイマーを再開します。${remainingStatusText(remainingAt(Date.now()))}`, voice);
    } else {
      await pauseFocusSession(session.id);
      stopVoice();
    }
  };
  const finish = async (complete: boolean) => {
    if (!complete) {
      await pauseFocusSession(session.id, '作業を中断');
      stopVoice();
      syncNow().catch(() => undefined);
      onClose();
      return;
    }
    await updateSession(session.id, { status: 'completed', endedAt: new Date().toISOString(), pausedAt: null }, '作業を完了');
    if (task) await completeTask(task.id, true);
    syncNow().catch(() => undefined); onClose();
  };
  return <div className="timer-dock"><div className="timer-title"><span className="live-dot" /><div><span>{remainingSec < 0 ? '予定を超過' : paused ? '一時停止' : '集中しています'}</span><strong>{session.taskTitle}</strong></div><IconButton label="小さくする" onClick={onClose}><X size={19} /></IconButton></div><button className="timer-display" type="button" onClick={pauseToggle}><span>{remainingSec < 0 ? '+' : ''}{time}</span><small>{paused ? '押して再開' : '押して一時停止'}</small></button><div className="timer-controls"><IconButton label={paused ? '再開' : '一時停止'} onClick={pauseToggle}>{paused ? <Play size={21} /> : <Pause size={21} />}</IconButton><button className="button secondary" type="button" onClick={() => updateSession(session.id, { plannedMin: session.plannedMin + 5 }, '5分延長')}>+5分</button><button className="button secondary" type="button" onClick={() => finish(false)}><Square size={16} />中断</button><button className="button complete" type="button" onClick={() => finish(true)}><Check size={17} />完了</button></div></div>;
}

function App() {
  const mobile = useMobile();
  const [page, setPage] = useState<Page>('today');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [timerVisible, setTimerVisible] = useState(true);
  const [actionMessage, setActionMessage] = useState('');
  const [syncState, setSyncState] = useState<SyncState>(getSyncState());
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const history = useLiveQuery(() => db.history.orderBy('createdAt').reverse().toArray(), [], []) || [];
  const voice = useLiveQuery(() => db.settings.get('voice') as Promise<VoiceConfig | undefined>, [], undefined);
  const undoRedo = useLiveQuery(() => getUndoRedoState(), [], { id: 'undo-redo' as const, undo: [], redo: [] });
  const activeSession = sessions.filter((session) => session.status === 'running' || session.status === 'paused').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const activeTask = activeSession ? tasks.find((task) => task.id === activeSession.taskId) : undefined;
  useEffect(() => startAutoSync(), []);
  useEffect(() => subscribeSync(setSyncState), []);
  useEffect(() => { if (page === 'calendar') setTimerVisible(false); }, [page]);
  useEffect(() => {
    const due = memos.filter((memo) => !memo.deletedAt && memo.reminderAt && new Date(memo.reminderAt).getTime() <= Date.now() && !sessionStorage.getItem(`memo-notified-${memo.id}`));
    if (due.length && Notification.permission === 'granted') due.forEach((memo) => { new Notification(memo.title || 'SASSHYメモ', { body: memo.body || '設定した時刻になりました' }); sessionStorage.setItem(`memo-notified-${memo.id}`, '1'); });
  }, [memos]);
  const startTimer = async (task: Task) => {
    if (activeSession?.taskId === task.id) {
      if (activeSession.status === 'paused') await resumeFocusSession(activeSession.id);
      setTimerVisible(true);
      if (voice?.enabled) speakVoice(activeSession.status === 'paused' ? '中断していたタイマーを再開します' : '実行中のタイマーに戻ります', voice);
      syncNow().catch(() => undefined);
      return;
    }
    if (voice?.enabled) speakVoice(`${task.estimateMin}分タイマーを開始します`, voice);
    await startFocusSession(task, task.estimateMin);
    setTimerVisible(true);
    syncNow().catch(() => undefined);
  };
  const reopenTimer = async () => {
    setTimerVisible(true);
    if (!activeSession || !voice?.enabled) return;
    if (activeSession.status === 'paused') {
      await resumeFocusSession(activeSession.id);
      speakVoice('中断していたタイマーを再開します', voice);
    } else {
      speakVoice('タイマー画面に戻りました', voice);
    }
  };
  const runHistoryAction = async (kind: 'undo' | 'redo') => {
    const result = kind === 'undo' ? await undoLatestTaskChange() : await redoLatestTaskChange();
    setActionMessage(result || (kind === 'undo' ? '戻せる操作はありません' : 'やり直せる操作はありません'));
    window.setTimeout(() => setActionMessage(''), 3200);
    if (result && !result.startsWith('他の端末')) syncNow().catch(() => undefined);
  };
  const navItems: { id: Page; icon: ReactNode }[] = [{ id: 'today', icon: <Sparkles /> }, { id: 'calendar', icon: <CalendarDays /> }, { id: 'inbox', icon: <Inbox /> }, { id: 'later', icon: <Clock3 /> }, { id: 'memos', icon: <MessageSquareText /> }, { id: 'history', icon: <History /> }, { id: 'settings', icon: <Settings /> }];
  return <div className="app-shell"><aside className={`sidebar${menuOpen ? ' open' : ''}`}><div className="brand"><span className="brand-mark">S</span><div><strong>SASSHY</strong><span>予定と集中</span></div></div><nav>{navItems.map((item) => <button type="button" key={item.id} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id); setMenuOpen(false); }}>{item.icon}<span>{PAGE_LABEL[item.id]}</span>{item.id === 'inbox' && <small>{tasks.filter((task) => !task.deletedAt && !task.scheduledDate && task.status !== 'done' && task.horizon === 'now').length}</small>}</button>)}</nav><div className={`sync-indicator ${syncState.phase}`}><span>{syncState.phase === 'error' || syncState.phase === 'offline' ? <CloudOff size={16} /> : <Cloud size={16} />}</span><div><strong>{syncState.message.split('・')[0]}</strong><small>{syncState.message.split('・').slice(1).join('・') || '端末に保存します'}</small></div></div></aside><main className="main-area"><header className="topbar"><IconButton label="メニュー" onClick={() => setMenuOpen(!menuOpen)}><Menu size={21} /></IconButton><div className="topbar-title"><span>{PAGE_LABEL[page]}</span><strong>{page === 'today' ? new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()) : 'SASSHY v2'}</strong></div><div className="topbar-actions"><IconButton label="元に戻す" onClick={() => runHistoryAction('undo')} disabled={!undoRedo?.undo.length}><Undo2 size={17} /></IconButton><IconButton label="やり直す" onClick={() => runHistoryAction('redo')} disabled={!undoRedo?.redo.length}><Redo2 size={17} /></IconButton><button className={`top-sync ${syncState.phase}`} type="button" onClick={() => syncNow(true).catch(() => undefined)} title={syncState.message}>{syncState.phase === 'syncing' ? <TimerReset size={17} /> : syncState.phase === 'error' ? <CloudOff size={17} /> : <Cloud size={17} />}<span>{syncState.phase === 'ok' ? '保存済み' : syncState.phase === 'syncing' ? '同期中' : '端末保存'}</span></button></div></header><div className="view-frame">{page === 'today' && <TodayPage tasks={tasks} sessions={sessions} onEdit={setEditing} onStart={startTimer} />}{page === 'calendar' && <CalendarPage tasks={tasks} sessions={sessions} onEdit={setEditing} onStart={startTimer} />}{page === 'inbox' && <InboxPage tasks={tasks} onEdit={setEditing} onStart={startTimer} />}{page === 'later' && <LaterPage tasks={tasks} onEdit={setEditing} onStart={startTimer} />}{page === 'memos' && <MemosPage memos={memos} onTaskCreated={(task) => { setPage('inbox'); setEditing(task); }} />}{page === 'history' && <HistoryPage history={history} tasks={tasks} />}{page === 'settings' && <SettingsPage tasks={tasks} memos={memos} sessions={sessions} />}</div></main>{editing && <TaskEditor task={editing} sessions={sessions} onClose={() => setEditing(null)} onStart={startTimer} />}{activeSession && voice && timerVisible && <TimerDock session={activeSession} task={activeTask} voice={voice} onClose={() => setTimerVisible(false)} />}{activeSession && !timerVisible && <button className="timer-reopen" type="button" onClick={reopenTimer} title={activeSession.status === 'paused' ? 'タイマーを再開' : 'タイマーを表示'}><Volume2 size={20} /><span>{activeSession.status === 'paused' ? '中断中・押して再開：' + activeSession.taskTitle : activeSession.taskTitle}</span></button>}{actionMessage && <div className="action-toast">{actionMessage}</div>}<nav className="mobile-nav">{navItems.slice(0, 5).map((item) => <button key={item.id} type="button" className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}>{item.icon}<span>{PAGE_LABEL[item.id]}</span></button>)}<button type="button" onClick={() => setMenuOpen(true)}><MoreHorizontal /><span>その他</span></button></nav>{menuOpen && mobile && <button className="menu-scrim" type="button" aria-label="メニューを閉じる" onClick={() => setMenuOpen(false)} />}</div>;
}

export default App;
