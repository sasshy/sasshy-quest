import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getPushConfig,
  getWorkStartNotificationStatus,
  type WorkStartNotificationStatus,
} from './push';
import {
  configureWorkStartDay,
  correctWorkStartRecords,
  disableWorkStartDay,
  recordExistingMainWork,
  recordWorkDayStarted,
  recordWorkFirstContact,
  setMorningProgress,
  skipWorkStartDay,
  snoozeWorkStart,
} from './store';
import { syncNow, type SyncState } from './sync';
import type { FocusSession, MorningProgress, Task, WorkStartDay } from './types';
import {
  latestSafeStart,
  localDateKey,
  sha256Hex,
  validateWorkStartDay,
  WORK_START_DIRECTION,
  workStartDay,
  workStartMetrics,
  workStartTask,
} from './work-start';

interface Props {
  tasks: Task[];
  sessions: FocusSession[];
  fallbackTask: Task | null;
  syncState: SyncState;
  onStart: (task: Task) => Promise<void>;
}

interface SetupDraft {
  taskId: string;
  anchorText: string;
  currentTarget: string;
  reviewOn: string;
  deadline: string;
  remainingEstimateMin: string;
  bufferMin: string;
  morningMilestone: string;
}

function toLocalInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function toIso(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error('日時を入力してください');
  return date.toISOString();
}

function nextReviewDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return localDateKey(date);
}

function minuteLabel(value: number | null, unknown = false): string {
  if (value === null) return unknown ? '不明' : '未記録';
  if (value < 60) return `${value}分`;
  return `${Math.floor(value / 60)}時間${value % 60 ? `${value % 60}分` : ''}`;
}

function timeLabel(value: string | null): string {
  if (!value) return '未記録';
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function emptyDraft(tasks: Task[], fallbackTask: Task | null): SetupDraft {
  const selected = fallbackTask || tasks[0] || null;
  return {
    taskId: selected?.id || '',
    anchorText: '',
    currentTarget: '',
    reviewOn: nextReviewDate(),
    deadline: '',
    remainingEstimateMin: String(selected?.estimateMin || 25),
    bufferMin: '60',
    morningMilestone: '',
  };
}

function draftFromDay(task: Task, day: WorkStartDay): SetupDraft {
  return {
    taskId: task.id,
    anchorText: day.anchorText,
    currentTarget: toLocalInput(day.currentTargetAt),
    reviewOn: day.reviewOn,
    deadline: toLocalInput(day.deadlineAt),
    remainingEstimateMin: String(day.remainingEstimateMin),
    bufferMin: String(day.bufferMin),
    morningMilestone: day.morningMilestone,
  };
}

export function WorkStartPanel({ tasks, sessions, fallbackTask, syncState, onStart }: Props) {
  const dateKey = localDateKey();
  const availableTasks = tasks.filter((task) => !task.deletedAt && task.status !== 'done' && task.status !== 'archived');
  const target = workStartTask(tasks, dateKey);
  const day = target ? workStartDay(target, dateKey) : null;
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState<SetupDraft>(() => emptyDraft(availableTasks, fallbackTask));
  const [reportOpen, setReportOpen] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [reportedStart, setReportedStart] = useState(() => toLocalInput(new Date().toISOString()));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [currentEndpointHash, setCurrentEndpointHash] = useState('');
  const [notificationStatus, setNotificationStatus] = useState<WorkStartNotificationStatus | null>(null);
  const [notificationStatusError, setNotificationStatusError] = useState('');
  const pushConfig = useLiveQuery(() => getPushConfig(), [], undefined);
  const metrics = useMemo(() => day ? workStartMetrics(day) : null, [day]);
  const activeSession = target
    ? sessions
      .filter((session) => !session.deletedAt && session.taskId === target.id && (session.status === 'running' || session.status === 'paused'))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    : undefined;

  useEffect(() => {
    let cancelled = false;
    if (!pushConfig?.enabled || !pushConfig.endpoint) {
      setCurrentEndpointHash('');
      return () => { cancelled = true; };
    }
    sha256Hex(pushConfig.endpoint).then((value) => {
      if (!cancelled) setCurrentEndpointHash(value);
    });
    return () => { cancelled = true; };
  }, [pushConfig?.enabled, pushConfig?.endpoint]);

  useEffect(() => {
    let cancelled = false;
    let interval = 0;
    const refresh = async () => {
      if (!target || !day || !pushConfig?.enabled || !day.notificationEndpointHash) {
        setNotificationStatus(null);
        setNotificationStatusError('');
        return;
      }
      try {
        const next = await getWorkStartNotificationStatus(target.id, dateKey);
        if (!cancelled) {
          setNotificationStatus(next);
          setNotificationStatusError('');
        }
      } catch {
        if (!cancelled) {
          setNotificationStatus(null);
          setNotificationStatusError('通知回数を確認できません');
        }
      }
    };
    void refresh();
    interval = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [target?.id, dateKey, day?.notificationEndpointHash, pushConfig?.enabled, syncState.phase]);

  const calculatedSafe = useMemo(() => {
    try {
      return latestSafeStart(toIso(draft.deadline), Number(draft.remainingEstimateMin), Number(draft.bufferMin));
    } catch {
      return '';
    }
  }, [draft.deadline, draft.remainingEstimateMin, draft.bufferMin]);

  const run = async (action: () => Promise<unknown>, success: string | ((result: unknown) => string)) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      setMessage(typeof success === 'function' ? success(result) : success);
      syncNow().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const openSetup = () => {
    setError('');
    setDraft(target && day ? draftFromDay(target, day) : emptyDraft(availableTasks, fallbackTask));
    setSetupOpen(true);
  };

  const saveSetup = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const selected = tasks.find((task) => task.id === draft.taskId);
      if (!selected) throw new Error('対象タスクを選んでください');
      const currentTargetAt = toIso(draft.currentTarget);
      const deadlineAt = toIso(draft.deadline);
      const remainingEstimateMin = Number(draft.remainingEstimateMin);
      const bufferMin = Number(draft.bufferMin);
      const previous = workStartDay(selected, dateKey);
      const push = await getPushConfig();
      const next: WorkStartDay = {
        enabled: true,
        anchorText: draft.anchorText.trim(),
        currentTargetAt,
        reviewOn: draft.reviewOn,
        deadlineAt,
        remainingEstimateMin,
        bufferMin,
        latestSafeStartAt: latestSafeStart(deadlineAt, remainingEstimateMin, bufferMin),
        workStartedAt: previous?.workStartedAt || null,
        firstContactAt: previous?.firstContactAt || null,
        mainStartedAt: previous?.mainStartedAt || null,
        mainStartReportedAt: previous?.mainStartReportedAt || null,
        mainSessionId: previous?.mainSessionId || null,
        morningMilestone: draft.morningMilestone.trim(),
        morningProgress: previous?.morningProgress || 'unrecorded',
        progressRecordedAt: previous?.progressRecordedAt || null,
        snoozedUntil: previous?.snoozedUntil || null,
        skippedAt: previous?.skippedAt || null,
        notificationEndpointHash: push.enabled && push.endpoint ? await sha256Hex(push.endpoint) : '',
      };
      const errors = validateWorkStartDay(next);
      if (errors.length) throw new Error(errors[0]);
      await configureWorkStartDay(selected.id, dateKey, next);
      setSetupOpen(false);
    }, '今日の開始支援を保存しました');
  };

  const saveCorrection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || !day) return;
    const form = new FormData(event.currentTarget);
    const optionalIso = (name: string) => {
      const value = String(form.get(name) || '');
      return value ? toIso(value) : null;
    };
    await run(async () => {
      await correctWorkStartRecords(target.id, dateKey, {
        workStartedAt: optionalIso('workStartedAt'),
        firstContactAt: optionalIso('firstContactAt'),
        mainStartedAt: optionalIso('mainStartedAt'),
      });
      setCorrectionOpen(false);
    }, '開始記録を訂正しました');
  };

  const reportExisting = async (unknown: boolean) => {
    if (!target) return;
    const session = activeSession;
    await run(async () => {
      const at = session?.startedAt || (unknown ? null : toIso(reportedStart));
      return recordExistingMainWork(target.id, dateKey, at, session?.id || null);
    }, unknown ? '本作業中（開始時刻不明）として記録しました' : '本作業の開始を記録しました');
    setReportOpen(false);
  };

  const startMain = async () => {
    if (!target) return;
    await run(() => onStart(target), activeSession?.status === 'paused' ? '本作業を再開しました' : '本作業を開始しました');
  };

  const setProgress = (value: MorningProgress) => {
    if (!target) return;
    void run(() => setMorningProgress(target.id, dateKey, value), '午前の進捗を記録しました');
  };

  const syncLabel = syncState.phase === 'ok'
    ? '通知へ反映済み'
    : syncState.phase === 'syncing'
      ? '端末に保存済み・通知へ反映中'
      : '端末に保存済み・通知への反映待ち';
  const locked = Boolean(day?.workStartedAt || day?.firstContactAt || day?.mainStartReportedAt);

  if (!target || !day) {
    return (
      <section className="focus-band work-start-panel">
        <div>
          <span className="eyebrow">NOW</span>
          <h2>今やる</h2>
        </div>
        <div className="work-start-empty">
          {fallbackTask ? (
            <div className="focus-task">
              <div>
                <strong>{fallbackTask.title}</strong>
                <span>{fallbackTask.estimateMin}分だけ、ここから始める</span>
              </div>
              <button className="start-button" type="button" onClick={() => onStart(fallbackTask)}>
                開始
              </button>
            </div>
          ) : (
            <span className="work-start-muted">今日のタスクを追加すると、ここに1件だけ出します</span>
          )}
          <button className="work-start-link" type="button" onClick={openSetup} disabled={!availableTasks.length}>
            仕事開始支援を設定
          </button>
          {setupOpen && renderSetupForm()}
          {error && <p className="work-start-error">{error}</p>}
        </div>
      </section>
    );
  }

  const mainUnknown = Boolean(day.mainStartReportedAt && !day.mainStartedAt);
  const canSnoozeNow = Date.now() >= Date.parse(day.currentTargetAt)
    && Date.now() < Date.parse(day.latestSafeStartAt);
  const notificationEndpointCurrent = Boolean(
    pushConfig?.enabled
    && currentEndpointHash
    && currentEndpointHash === day.notificationEndpointHash,
  );
  const canSnooze = canSnoozeNow
    && notificationEndpointCurrent
    && syncState.phase === 'ok'
    && notificationStatus !== null
    && !notificationStatus.reached;
  const notificationState = !pushConfig?.enabled || !day.notificationEndpointHash
    ? {
      kind: 'off',
      title: '開始支援の通知はOFFです',
      detail: 'Current Targetと防衛線は画面に表示します。割込み通知は送りません。',
    }
    : !notificationEndpointCurrent
      ? {
        kind: 'pending',
        title: '通知先の再確認が必要です',
        detail: 'この端末で通知を再登録し、開始支援の設定を保存し直してください。',
      }
      : syncState.phase !== 'ok'
        ? {
          kind: 'pending',
          title: '端末に保存済み・通知への反映待ち',
          detail: '同期が完了するまで「10分後」は予約済みと扱いません。',
        }
        : notificationStatusError
          ? {
            kind: 'pending',
            title: notificationStatusError,
            detail: '回数を確認できるまで追加の通知予約は行いません。',
          }
          : notificationStatus?.reached
            ? {
              kind: 'limit',
              title: `開始支援は上限${notificationStatus.limit}回に到達しました`,
              detail: '延期を追加しても、防衛線を含む通知回数は増やしません。',
            }
            : notificationStatus
              ? {
                kind: 'ready',
                title: `開始支援 ${notificationStatus.attempts}/${notificationStatus.limit}回送信試行済み`,
                detail: 'Current Target・10分後・防衛線を合わせた上限です。',
              }
              : {
                kind: 'pending',
                title: '通知回数を確認中です',
                detail: '確認が終わるまで追加の通知予約は行いません。',
              };
  const nextStep = day.mainStartReportedAt
    ? activeSession?.status === 'paused'
      ? '中断位置から再開する'
      : activeSession
        ? '既存タイマーで進行中'
        : '本作業開始を記録済み'
    : day.firstContactAt
      ? '次は本作業を始める'
      : day.anchorText;
  const stateLabel = day.skippedAt
    ? '今日は見送り'
    : day.mainStartReportedAt
      ? activeSession?.status === 'paused' ? '本作業を中断中' : activeSession ? '本作業中' : '本作業開始済み'
      : day.firstContactAt
        ? '初回接触済み・本作業前'
        : day.workStartedAt
          ? '仕事開始済み・初回接触前'
          : '仕事開始前';

  return (
    <section className="focus-band work-start-panel active">
      <div className="work-start-heading">
        <span className="eyebrow">NOW / PHASE 1</span>
        <h2>重要仕事</h2>
        <small>{stateLabel}</small>
      </div>
      <div className="work-start-body">
        <div className="work-start-title">
          <div>
            <strong>{target.title}</strong>
            <span>{nextStep}</span>
          </div>
          {!day.workStartedAt && !day.mainStartReportedAt && !day.skippedAt && (
            <button className="start-button" type="button" disabled={busy} onClick={() => run(() => recordWorkDayStarted(target.id, dateKey), '仕事開始を記録しました')}>
              仕事開始
            </button>
          )}
          {day.workStartedAt && !day.firstContactAt && !day.mainStartReportedAt && !day.skippedAt && (
            <div className="work-start-primary-actions">
              <button className="button complete" type="button" disabled={busy} onClick={() => run(() => recordWorkFirstContact(target.id, dateKey), '初回接触を記録しました')}>接触した</button>
              <button className="button primary" type="button" disabled={busy} onClick={startMain}>本作業を始める</button>
            </div>
          )}
          {day.firstContactAt && !day.mainStartReportedAt && !day.skippedAt && (
            <button className="start-button" type="button" disabled={busy} onClick={startMain}>本作業を始める</button>
          )}
          {day.mainStartReportedAt && activeSession && (
            <button className="start-button" type="button" disabled={busy} onClick={startMain}>
              {activeSession.status === 'paused' ? '再開' : 'タイマーへ'}
            </button>
          )}
        </div>

        <p className="work-start-direction">Direction：{WORK_START_DIRECTION}</p>
        <div className="work-start-times">
          <span><small>Current Target</small><strong>{timeLabel(day.currentTargetAt)}</strong></span>
          <span className={Date.now() > Date.parse(day.latestSafeStartAt) && !day.mainStartReportedAt ? 'late' : ''}>
            <small>Latest Safe Start</small><strong>{timeLabel(day.latestSafeStartAt)}</strong>
          </span>
          <span><small>見直し日</small><strong>{day.reviewOn || '未設定'}</strong></span>
        </div>

        {!day.mainStartReportedAt && !day.skippedAt && (
          <div className="work-start-secondary-actions">
            {!day.workStartedAt && <button className="button secondary" type="button" disabled={busy} onClick={startMain}>直接、本作業を始める</button>}
            {canSnoozeNow && <button className="button secondary" type="button" disabled={busy || !canSnooze} onClick={() => run(async () => {
              const fresh = await getWorkStartNotificationStatus(target.id, dateKey);
              setNotificationStatus(fresh);
              if (fresh.reached) return { scheduledAt: null, limitReached: true };
              return snoozeWorkStart(target.id, dateKey);
            }, (result) => {
              const value = result as { scheduledAt: string | null; limitReached?: boolean };
              if (value.limitReached) return '開始支援は上限に達しているため、追加通知は予約しません';
              return value.scheduledAt
                ? `${timeLabel(value.scheduledAt)}への延期を端末に保存しました・通知への反映待ち`
                : '防衛線以降の追加通知は予約しません';
            })}>10分後</button>}
            <button className="button secondary" type="button" disabled={busy} onClick={() => setReportOpen(!reportOpen)}>既に進行中</button>
            <button className="button danger-quiet" type="button" disabled={busy} onClick={() => run(() => skipWorkStartDay(target.id, dateKey), '今日は見送りました')}>今回は見送る</button>
          </div>
        )}

        {reportOpen && (
          <div className="work-start-report">
            {activeSession ? (
              <p>実行中のタイマー開始時刻（{timeLabel(activeSession.startedAt)}）を使います。</p>
            ) : (
              <label>本作業開始時刻<input type="datetime-local" value={reportedStart} onChange={(event) => setReportedStart(event.target.value)} /></label>
            )}
            <div>
              <button className="button primary" type="button" disabled={busy} onClick={() => reportExisting(false)}>この時刻で記録</button>
              {!activeSession && <button className="button secondary" type="button" disabled={busy} onClick={() => reportExisting(true)}>開始時刻は不明</button>}
            </div>
          </div>
        )}

        <div className="work-start-metrics">
          <span><small>仕事開始→接触</small><strong>{minuteLabel(metrics?.workToContactMin ?? null)}</strong></span>
          <span><small>仕事開始→本作業</small><strong>{minuteLabel(metrics?.workToMainMin ?? null, mainUnknown)}</strong></span>
          <span><small>接触→本作業</small><strong>{minuteLabel(metrics?.contactToMainMin ?? null, mainUnknown)}</strong></span>
          <span><small>防衛線</small><strong>{metrics?.safeStartStatus === 'within' ? '超過なし' : metrics?.safeStartStatus === 'exceeded' ? '超過' : '不明'}</strong></span>
        </div>

        {day.morningMilestone && (
          <div className="work-start-progress">
            <span>午前の工程：<strong>{day.morningMilestone}</strong></span>
            <div>
              {([['not_started', '未着手'], ['partial', '一部'], ['completed', '完了']] as const).map(([value, label]) => (
                <button key={value} type="button" className={day.morningProgress === value ? 'active' : ''} disabled={busy} onClick={() => setProgress(value)}>{label}</button>
              ))}
            </div>
          </div>
        )}

        <div className={`work-start-notification-state ${notificationState.kind}`} role="status">
          <strong>{notificationState.title}</strong>
          <span>{notificationState.detail}</span>
        </div>

        <div className="work-start-footer">
          <span>{day.notificationEndpointHash ? syncLabel : 'この端末のバックグラウンド通知は未設定'}</span>
          {!locked && <button type="button" onClick={openSetup}>設定を編集</button>}
          <button type="button" onClick={() => setCorrectionOpen(!correctionOpen)}>記録訂正</button>
          <button type="button" onClick={() => run(() => disableWorkStartDay(target.id, dateKey), '今日の開始支援を停止しました')}>支援を停止</button>
        </div>

        {setupOpen && renderSetupForm()}
        {correctionOpen && (
          <form className="work-start-correction" onSubmit={saveCorrection}>
            <label>仕事開始<input name="workStartedAt" type="datetime-local" defaultValue={toLocalInput(day.workStartedAt)} /></label>
            <label>初回接触<input name="firstContactAt" type="datetime-local" defaultValue={toLocalInput(day.firstContactAt)} /></label>
            <label>本作業開始<input name="mainStartedAt" type="datetime-local" defaultValue={toLocalInput(day.mainStartedAt)} /></label>
            <button className="button primary" type="submit" disabled={busy}>訂正を保存</button>
          </form>
        )}
        {message && <p className="work-start-message">{message}</p>}
        {error && <p className="work-start-error">{error}</p>}
      </div>
    </section>
  );

  function renderSetupForm() {
    return (
      <form className="work-start-setup" onSubmit={saveSetup}>
        <label>今日の重要仕事
          <select value={draft.taskId} disabled={locked} onChange={(event) => {
            const selected = tasks.find((task) => task.id === event.target.value);
            setDraft({ ...draft, taskId: event.target.value, remainingEstimateMin: String(selected?.estimateMin || 25) });
          }}>
            <option value="">選択してください</option>
            {availableTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
        </label>
        <label>Morning Anchor（1〜5分）<input required value={draft.anchorText} onChange={(event) => setDraft({ ...draft, anchorText: event.target.value })} placeholder="商品を机に出す" /></label>
        <label>Current Target<input required type="datetime-local" value={draft.currentTarget} onChange={(event) => setDraft({ ...draft, currentTarget: event.target.value })} /></label>
        <label>実期限<input required type="datetime-local" value={draft.deadline} onChange={(event) => setDraft({ ...draft, deadline: event.target.value })} /></label>
        <label>残作業（分）<input required min="1" max="720" type="number" value={draft.remainingEstimateMin} onChange={(event) => setDraft({ ...draft, remainingEstimateMin: event.target.value })} /></label>
        <label>余裕（分）<input required min="0" max="720" type="number" value={draft.bufferMin} onChange={(event) => setDraft({ ...draft, bufferMin: event.target.value })} /></label>
        <label>見直し日<input required type="date" value={draft.reviewOn} onChange={(event) => setDraft({ ...draft, reviewOn: event.target.value })} /></label>
        <label>午前の工程（任意）<input value={draft.morningMilestone} onChange={(event) => setDraft({ ...draft, morningMilestone: event.target.value })} placeholder="午前分の梱包を終える" /></label>
        <p className="work-start-safe-preview">Latest Safe Start：{calculatedSafe ? `${new Date(calculatedSafe).toLocaleDateString('ja-JP')} ${timeLabel(calculatedSafe)}` : '実期限・残作業・余裕から計算'}</p>
        <div className="work-start-form-actions">
          <button className="button secondary" type="button" onClick={() => setSetupOpen(false)}>閉じる</button>
          <button className="button primary" type="submit" disabled={busy}>開始支援を保存</button>
        </div>
      </form>
    );
  }
}
