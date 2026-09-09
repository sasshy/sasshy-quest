import { useMemo, useState } from 'react';
import {
  recordScheduleResult,
  resolveScheduleConflictWithLocal,
  resolveScheduleConflictWithRemote,
} from './store';
import { syncNow } from './sync';
import {
  latestResultsByVersion,
  scheduleOperationLabel,
  scheduleResultLabel,
  scheduleSnapshot,
} from './schedule-history';
import type { ScheduleHistoryEntry, ScheduleOutboxItem, ScheduleResult, ScheduleSnapshot, Task } from './types';

function minuteLabel(value: number | null): string {
  if (value === null) return '時刻なし';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function snapshotLabel(snapshot: ScheduleSnapshot | null): string {
  if (!snapshot?.scheduledDate) return '日付なし';
  return `${snapshot.scheduledDate} ${minuteLabel(snapshot.startMinute)}・${snapshot.durationMin}分`;
}

function ResultEditor({
  task,
  snapshot,
  current,
  result,
  onSaved,
}: {
  task: Task;
  snapshot: ScheduleSnapshot;
  current: boolean;
  result: ScheduleResult;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<ScheduleResult>(result);
  const [reason, setReason] = useState('');
  const [moveToSomeday, setMoveToSomeday] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const closes = current && ['not_done', 'cancelled', 'skipped'].includes(selected);
  const stopsSupport = current
    && ['cancelled', 'skipped'].includes(selected)
    && Boolean(snapshot.scheduledDate && task.workStartSupport?.days[snapshot.scheduledDate]?.enabled);
  return (
    <div className="schedule-result-editor">
      <select aria-label={`${snapshotLabel(snapshot)}の結果`} value={selected} onChange={(event) => setSelected(event.currentTarget.value as ScheduleResult)}>
        <option value="unconfirmed">未確認</option>
        <option value="completed">完了</option>
        <option value="not_done">未実行</option>
        <option value="cancelled">キャンセル</option>
        <option value="skipped">見送り</option>
      </select>
      <input value={reason} onChange={(event) => setReason(event.currentTarget.value)} placeholder="理由（任意）" />
      {current && selected === 'skipped' && (
        <label className="schedule-someday-choice">
          <input type="checkbox" checked={moveToSomeday} onChange={(event) => setMoveToSomeday(event.currentTarget.checked)} />
          タスクを「いつか」へ移す
        </label>
      )}
      {closes && <small>現在の予定枠を閉じて日付なしにします。タスクは残ります。</small>}
      {stopsSupport && <small>この結果を保存すると、同日の仕事開始支援も停止します。</small>}
      {error && <small className="schedule-history-error">{error}</small>}
      <button
        className="button secondary"
        type="button"
        disabled={(selected === 'unconfirmed' && result === 'unconfirmed') || saving}
        onClick={async () => {
          setSaving(true);
          setError('');
          try {
            await recordScheduleResult(task.id, snapshot.scheduleVersionId, selected, reason, moveToSomeday);
            syncNow().catch(() => undefined);
            onSaved();
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : '結果を保存できませんでした');
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? '保存中…' : result === 'unconfirmed' ? '結果を保存' : '結果を訂正'}
      </button>
    </div>
  );
}

export function ScheduleHistoryPanel({
  task,
  entries,
  conflicts,
  onChanged,
}: {
  task: Task;
  entries: ScheduleHistoryEntry[];
  conflicts: ScheduleOutboxItem[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const versions = useMemo(() => {
    const snapshots = new Map<string, ScheduleSnapshot>();
    entries.forEach((entry) => [entry.before, entry.after].forEach((snapshot) => {
      if (snapshot?.scheduleVersionId) snapshots.set(snapshot.scheduleVersionId, snapshot);
    }));
    const current = scheduleSnapshot(task);
    if (current.scheduleVersionId) snapshots.set(current.scheduleVersionId, current);
    if (!current.scheduleVersionId && current.scheduledDate) snapshots.set('__current__', current);
    return [...snapshots.entries()].reverse();
  }, [entries, task]);
  const results = useMemo(() => latestResultsByVersion(entries), [entries]);
  const conflict = conflicts.find((item) => item.conflictRevision);

  if (!versions.length && !entries.length && !conflict) return null;
  return (
    <section className="schedule-history-panel">
      <header>
        <div>
          <strong>予定の経緯と結果</strong>
          <span>再予定は自動で失敗扱いにしません</span>
        </div>
        <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? '閉じる' : '表示'}</button>
      </header>
      {conflict && (
        <div className="schedule-conflict">
          <strong>別の端末でも予定が変更されています</strong>
          <span>端末側の変更と履歴は保持しています。採用する予定を選んでください。</span>
          <div>
            <button className="button secondary" type="button" onClick={async () => {
              await resolveScheduleConflictWithRemote(task.id);
              onChanged();
            }}>クラウド予定を採用</button>
            <button className="button primary" type="button" onClick={async () => {
              await resolveScheduleConflictWithLocal(task.id);
              syncNow().catch(() => undefined);
              onChanged();
            }}>この端末の予定で再送</button>
          </div>
        </div>
      )}
      {expanded && (
        <div className="schedule-history-body">
          {versions.map(([key, snapshot]) => {
            const current = snapshot.scheduleVersionId
              ? snapshot.scheduleVersionId === task.scheduleVersionId
              : key === '__current__';
            const result = snapshot.scheduleVersionId
              ? results.get(snapshot.scheduleVersionId) || 'unconfirmed'
              : 'unconfirmed';
            return (
              <article key={key} className={current ? 'current' : ''}>
                <div className="schedule-version-title">
                  <strong>{snapshotLabel(snapshot)}</strong>
                  <span>{current ? '現在の予定' : '過去の予定'}・{scheduleResultLabel[result]}</span>
                </div>
                <ResultEditor task={task} snapshot={snapshot} current={current} result={result} onSaved={onChanged} />
              </article>
            );
          })}
          <ol className="schedule-history-chain">
            {[...entries].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).map((entry) => (
              <li key={entry.id}>
                <strong>{scheduleOperationLabel[entry.operation]}</strong>
                <span>{snapshotLabel(entry.before)} → {snapshotLabel(entry.after)}</span>
                <small>操作 {new Date(entry.occurredAt).toLocaleString('ja-JP')}{entry.reason ? `・${entry.reason}` : ''}</small>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
