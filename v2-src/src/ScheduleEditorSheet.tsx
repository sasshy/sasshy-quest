import { useMemo, useState } from 'react';
import { createTask, updateTask } from './store';
import { syncNow } from './sync';
import type { Task } from './types';

function shiftDate(value: string, amount: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function minuteLabel(value: number | null): string {
  if (value === null) return '時刻なし';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function parseMinute(value: string): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export interface ScheduleDraftSeed {
  scheduledDate: string;
  startMinute: number | null;
  durationMin: number;
}

export function ScheduleEditorSheet({
  task,
  seed,
  onClose,
  onSaved,
  onOpenDetails,
}: {
  task: Task | null;
  seed: ScheduleDraftSeed;
  onClose: () => void;
  onSaved: (task: Task, message: string) => void;
  onOpenDetails?: (task: Task) => void;
}) {
  const originalDate = task?.scheduledDate || seed.scheduledDate;
  const [title, setTitle] = useState(task?.title || '');
  const [date, setDate] = useState<string | null>(task?.scheduledDate || seed.scheduledDate);
  const [startMinute, setStartMinute] = useState<number | null>(task?.startMinute ?? seed.startMinute);
  const [durationMin, setDurationMin] = useState(task?.durationMin || seed.durationMin);
  const [saving, setSaving] = useState(false);
  const phase1Continues = Boolean(
    task
    && task.scheduledDate
    && task.workStartSupport?.days[task.scheduledDate]?.enabled,
  );
  const changed = !task
    || date !== task.scheduledDate
    || startMinute !== task.startMinute
    || durationMin !== task.durationMin;
  const destination = useMemo(
    () => date ? `${date} ${minuteLabel(startMinute)}・${durationMin}分` : '日付なし',
    [date, durationMin, startMinute],
  );

  const save = async () => {
    if (!title.trim() || !date || saving || !changed) return;
    setSaving(true);
    try {
      const saved = task
        ? await updateTask(task.id, {
            scheduledDate: date,
            startMinute,
            durationMin: Math.max(5, durationMin),
            estimateMin: Math.max(5, durationMin),
          }, '日時変更シートで予定を移動')
        : await createTask({
            title: title.trim(),
            scheduledDate: date,
            startMinute,
            durationMin: Math.max(5, durationMin),
            estimateMin: Math.max(5, durationMin),
          });
      if (!saved) throw new Error('予定を保存できませんでした');
      onSaved(saved, task ? `${task.title}を ${destination} へ移動しました` : `${saved.title}を ${destination} に追加しました`);
      syncNow().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const unschedule = async () => {
    if (!task || saving) return;
    setSaving(true);
    try {
      const saved = await updateTask(task.id, {
        scheduledDate: null,
        startMinute: null,
      }, '日時変更シートで予定を解除');
      if (!saved) throw new Error('予定を解除できませんでした');
      onSaved(saved, `${task.title}を日付なしへ移動しました`);
      syncNow().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop schedule-sheet-backdrop" role="presentation">
      <section className="modal-sheet schedule-sheet" role="dialog" aria-modal="true" aria-labelledby="schedule-sheet-title">
        <header>
          <div>
            <span className="eyebrow">SCHEDULE</span>
            <h2 id="schedule-sheet-title">{task ? '日時を変更' : '予定を追加'}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}>×</button>
        </header>
        <div className="schedule-sheet-body">
          {!task && (
            <label>
              <span>タスク名</span>
              <input autoFocus value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
            </label>
          )}
          {task && (
            <div className="schedule-origin">
              <small>移動前</small>
              <strong>{task.scheduledDate || '日付なし'} {minuteLabel(task.startMinute)}・{task.durationMin}分</strong>
            </div>
          )}
          <div className="schedule-shortcuts" role="group" aria-label="元の予定から移動">
            <button type="button" onClick={() => setDate(shiftDate(originalDate, 1))}>翌日</button>
            <button type="button" onClick={() => setDate(shiftDate(originalDate, 7))}>1週間後</button>
          </div>
          <div className="schedule-fields">
            <label>
              <span>日付</span>
              <input type="date" value={date || ''} onChange={(event) => setDate(event.currentTarget.value || null)} />
            </label>
            <label>
              <span>時刻</span>
              <input
                type="time"
                value={startMinute === null ? '' : minuteLabel(startMinute)}
                onChange={(event) => setStartMinute(parseMinute(event.currentTarget.value))}
              />
            </label>
            <label>
              <span>予定時間</span>
              <input
                type="number"
                min="5"
                max="720"
                step="5"
                value={durationMin}
                onChange={(event) => setDurationMin(Math.max(5, Number(event.currentTarget.value) || 5))}
              />
            </label>
          </div>
          <div className="schedule-destination">
            <small>移動先</small>
            <strong>{destination}</strong>
          </div>
          {phase1Continues && (
            <p className="schedule-phase1-note">
              日時変更や予定解除だけでは、この日の仕事開始支援は停止しません。見送り・キャンセル時は結果欄から記録してください。
            </p>
          )}
        </div>
        <footer className="modal-actions schedule-sheet-actions">
          {task && (
            <button className="button danger-quiet" type="button" disabled={saving} onClick={unschedule}>予定解除</button>
          )}
          {task && onOpenDetails && (
            <button className="button secondary" type="button" onClick={() => onOpenDetails(task)}>詳細・結果</button>
          )}
          <span className="spacer" />
          <button className="button secondary" type="button" onClick={onClose}>キャンセル</button>
          <button className="button primary" type="button" disabled={!title.trim() || !date || !changed || saving} onClick={save}>
            {saving ? '保存中…' : 'この日時で保存'}
          </button>
        </footer>
      </section>
    </div>
  );
}
