import { useMemo, useState } from 'react';
import { effectiveScheduleChanges, scheduleHistoryDates, scheduleOperationLabel } from './schedule-history';
import type { ScheduleHistoryEntry, Task } from './types';

function minuteLabel(value: number | null): string {
  if (value === null) return '時刻なし';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function CalendarDayDetail({
  date,
  tasks,
  history,
  onClose,
  onEdit,
  onMove,
}: {
  date: string;
  tasks: Task[];
  history: ScheduleHistoryEntry[];
  onClose: () => void;
  onEdit: (task: Task) => void;
  onMove: (task: Task) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const dayTasks = useMemo(() => tasks
    .filter((task) => !task.deletedAt && task.status !== 'done' && task.scheduledDate === date)
    .sort((a, b) => (a.startMinute ?? 1440) - (b.startMinute ?? 1440)), [date, tasks]);
  const dayHistory = useMemo(() => effectiveScheduleChanges(history)
    .filter((entry) => scheduleHistoryDates(entry).includes(date))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [date, history]);
  const rescheduleCount = dayHistory.filter((entry) =>
    ['reschedule', 'adjust_date', 'adjust_time'].includes(entry.operation)
  ).length;

  return (
    <aside className="calendar-day-detail" aria-label={`${date}の詳細`}>
      <header>
        <div>
          <small>DAY DETAIL</small>
          <strong>{date}</strong>
        </div>
        <button className="icon-button" type="button" aria-label="日別詳細を閉じる" onClick={onClose}>×</button>
      </header>
      <div className="calendar-day-detail-body">
        <section>
          <h3>現在の予定 <span>{dayTasks.length}件</span></h3>
          {dayTasks.length ? dayTasks.map((task) => (
            <article key={task.id} className={date < new Date().toLocaleDateString('sv-SE') && task.status !== 'done' ? 'unconfirmed-past' : ''}>
              <button type="button" onClick={() => onMove(task)}>
                <strong>{minuteLabel(task.startMinute)}</strong>
                <span>{task.title}</span>
                <small>{task.durationMin}分</small>
              </button>
              <button type="button" onClick={() => onEdit(task)}>詳細・結果</button>
            </article>
          )) : <p>現在の予定はありません。</p>}
        </section>
        <section className="calendar-day-history-summary">
          <button type="button" onClick={() => setShowHistory((value) => !value)}>
            <span>予定の経緯</span>
            <strong>{rescheduleCount ? `再予定等 ${rescheduleCount}件` : `${dayHistory.length}件`}</strong>
            <small>{showHistory ? '閉じる' : '展開'}</small>
          </button>
          {showHistory && (
            <ol>
              {dayHistory.map((entry) => (
                <li key={entry.id}>
                  <strong>{scheduleOperationLabel[entry.operation]}・{entry.title}</strong>
                  <span>{entry.before?.scheduledDate || '日付なし'} → {entry.after?.scheduledDate || '日付なし'}</span>
                  <small>操作 {new Date(entry.occurredAt).toLocaleString('ja-JP')}</small>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </aside>
  );
}
