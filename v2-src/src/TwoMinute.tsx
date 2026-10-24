import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { setFocusSessionPlannedMinutes, updateSession, updateTask } from "./store";
import { syncNow } from "./sync";
import { localDateKey, shiftDateKey } from "./meals";
import type { FocusSession } from "./types";
import { isStale } from "./StaleSession";

/** Seconds left on a session (negative = over). */
export function sessionRemainingSec(session: FocusSession, now = Date.now()): number {
  const at = session.status === "paused" && session.pausedAt ? new Date(session.pausedAt).getTime() : now;
  const elapsed = Math.max(0, Math.floor((at - new Date(session.startedAt).getTime()) / 1000 - session.pausedTotalSec));
  return session.plannedMin * 60 - (session.carriedElapsedSec || 0) - elapsed;
}

/** Planned minutes so that only `minutes` more run on top of what was already done. */
export function starterPlannedMin(carriedElapsedSec: number, minutes = 2): number {
  return Math.ceil(Math.max(0, carriedElapsedSec) / 60) + minutes;
}

/**
 * 「2分だけ」 finished: no pressure. Keep going, two more minutes, or stop here
 * (counts as having started, and the task becomes tomorrow's first).
 */
export function TwoMinutePrompt() {
  const session = useLiveQuery(
    () => db.sessions.where("status").anyOf("running", "paused").filter((s) => Boolean(s.starter) && !s.deletedAt).first(),
    [],
    undefined,
  );
  const touches = useLiveQuery(
    async () => (session ? db.sessions.filter((s) => s.taskId === session.taskId && !s.deletedAt).count() : 0),
    [session?.taskId],
    0,
  ) || 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session?.id]);
  if (!session || session.status !== "running" || sessionRemainingSec(session, now) > 0 || isStale(session, now)) return null;

  const keepGoing = async () => {
    const task = await db.tasks.get(session.taskId);
    const doneSec = session.plannedMin * 60 - sessionRemainingSec(session);
    const target = Math.max(task?.estimateMin || 15, Math.ceil(doneSec / 60) + 10);
    await updateSession(session.id, { starter: false }, "2分だけ → 続ける");
    await setFocusSessionPlannedMinutes(session.id, target);
    syncNow().catch(() => undefined);
  };
  const twoMore = async () => {
    await setFocusSessionPlannedMinutes(session.id, session.plannedMin + 2);
    syncNow().catch(() => undefined);
  };
  const stopHere = async () => {
    await updateSession(session.id, { status: "interrupted", endedAt: new Date().toISOString(), pausedAt: null, starter: false }, "2分だけ → ここまで");
    const tomorrow = shiftDateKey(localDateKey(Date.now()), 1);
    await updateTask(session.taskId, { scheduledDate: tomorrow, startMinute: null, isFixed: false, status: "planned", flowOrder: -900 }, "明日の1つ目に置く");
    syncNow().catch(() => undefined);
  };

  return createPortal(
    <div className="two-min" role="dialog" aria-modal="true" aria-labelledby="two-min-title">
      <span className="two-min-task">{session.taskTitle}</span>
      <div className="two-min-ring"><strong>2:00</strong><small>2分たちました</small></div>
      <h2 id="two-min-title">手をつけた。それで勝ち。</h2>
      <p>ここでやめても「1回やった」に数えます。<br />乗ってきたなら、そのまま続けられます。</p>
      <div className="two-min-actions">
        <button type="button" className="primary" onClick={keepGoing}>このまま続ける</button>
        <button type="button" onClick={twoMore}>もう2分だけ</button>
        <button type="button" className="quiet" onClick={stopHere}>今日はここまで（明日の1つ目に置く）</button>
      </div>
      <small className="two-min-count">この作業に手をつけた回数：{touches}回</small>
    </div>,
    document.body,
  );
}
