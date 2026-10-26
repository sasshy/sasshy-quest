import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { completeTask, discardFocusSession, updateSession } from "./store";
import { syncNow } from "./sync";
import type { FocusSession } from "./types";

/** Past this much overtime the session is closed at its planned end (it can be fixed afterwards). */
export const AUTO_CUT_SEC = 2 * 60 * 60;
const MIN = 60_000;

/** When the planned time ran out, counting pauses. */
export function plannedEndMs(session: FocusSession): number {
  return new Date(session.startedAt).getTime()
    + (session.plannedMin * 60 - (session.carriedElapsedSec || 0) + session.pausedTotalSec) * 1000;
}

/** Seconds past the planned end for a running session (0 when not over). */
export function overtimeSec(session: FocusSession, now = Date.now()): number {
  if (session.status !== "running") return 0;
  return Math.max(0, Math.floor((now - plannedEndMs(session)) / 1000));
}

/** Ran so far over that it was surely forgotten: ask instead of opening the timer. */
export function isStale(session: FocusSession, now = Date.now()): boolean {
  if (session.interrupt?.auto) return false;
  return overtimeSec(session, now) >= Math.max(20 * 60, session.plannedMin * 60);
}

/** An automatic detour record is closed after this long (you surely moved on). */
export const AUTO_DETOUR_MAX_MS = 30 * 60_000;

/** Close forgotten sessions at their planned end. Returns the sessions that were cut. */
export async function autoCutForgotten(now = Date.now()): Promise<FocusSession[]> {
  const running = await db.sessions.where("status").equals("running").toArray();
  const cut: FocusSession[] = [];
  for (const s of running) {
    if (s.deletedAt) continue;
    // 寄り道の記録（タスク）を手で始めてしまったタイマーは、なかったことにする。
    if (!s.interrupt && (await db.tasks.get(s.taskId))?.log) {
      await discardFocusSession(s.id);
      continue;
    }
    if (s.interrupt?.auto) {
      if (now - Date.parse(s.startedAt) < AUTO_DETOUR_MAX_MS) continue;
      const closed = await updateSession(s.id, {
        status: "completed",
        endedAt: new Date(Date.parse(s.startedAt) + AUTO_DETOUR_MAX_MS).toISOString(),
        pausedAt: null,
      }, "寄り道の記録を30分で区切る");
      await completeTask(s.taskId, true);
      if (closed) cut.push(closed);
      continue;
    }
    if (overtimeSec(s, now) < AUTO_CUT_SEC) continue;
    const done = await updateSession(s.id, {
      status: "interrupted",
      endedAt: new Date(plannedEndMs(s)).toISOString(),
      pausedAt: null,
      autoStopped: true,
      starter: false,
    }, "止め忘れのため予定の時間で区切る");
    if (done) cut.push(done);
  }
  return cut;
}

const minutesText = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`);

/**
 * おかえり: a forgotten timer is not shown as a huge overtime. One tap says how
 * long it really took (and whether it got done); the record is fixed right away.
 */
export function StaleSessionPrompt() {
  const [now, setNow] = useState(() => Date.now());
  const [snoozed, setSnoozed] = useState<Record<string, number>>({});
  const [minutes, setMinutes] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      autoCutForgotten().then((cut) => { if (cut.length) syncNow().catch(() => undefined); }).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  const session = useLiveQuery(async () => {
    const recent = await db.sessions.filter((s) => !s.deletedAt && (
      (s.status === "running" && isStale(s, Date.now())) ||
      (Boolean(s.autoStopped) && !s.reviewed && Date.now() - Date.parse(s.updatedAt) < 3 * 86_400_000)
    )).toArray();
    return recent.sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  }, [now], undefined);
  useEffect(() => setMinutes(null), [session?.id]);
  if (!session || (snoozed[session.id] || 0) > now) return null;

  const started = new Date(session.startedAt).getTime();
  const elapsedMin = Math.floor((now - started - session.pausedTotalSec * 1000) / MIN);
  const planned = Math.max(1, session.plannedMin - Math.floor((session.carriedElapsedSec || 0) / 60));
  const choices = [planned, 15, 30, 45, 60, 90].filter((m, i, all) => m <= elapsedMin && all.indexOf(m) === i).sort((a, b) => a - b);
  const picked = minutes ?? planned;
  const auto = Boolean(session.autoStopped);

  const record = async (done: boolean) => {
    const endedAt = new Date(started + (picked * 60 + session.pausedTotalSec) * 1000).toISOString();
    await updateSession(session.id, {
      status: done ? "completed" : "interrupted",
      endedAt,
      pausedAt: null,
      reviewed: true,
      starter: false,
    }, `実際は${minutesText(picked)}として記録`);
    if (done) await completeTask(session.taskId, true);
    syncNow().catch(() => undefined);
  };
  const stillWorking = async () => {
    // 続けているなら、今から15分のラウンドとして数え直す。
    const runMin = Math.ceil((now - started) / MIN - session.pausedTotalSec / 60);
    await updateSession(session.id, { plannedMin: runMin + 15 + Math.ceil((session.carriedElapsedSec || 0) / 60) }, "まだ続けている");
    setSnoozed((s) => ({ ...s, [session.id]: Date.now() + 20 * MIN }));
    syncNow().catch(() => undefined);
  };
  const notDone = async () => {
    const at = new Date().toISOString();
    await updateSession(session.id, { status: "interrupted", endedAt: at, pausedAt: null, deletedAt: at, reviewed: true }, "やっていなかったので記録しない");
    syncNow().catch(() => undefined);
  };

  return createPortal(
    <div className="stale" role="dialog" aria-modal="true" aria-labelledby="stale-title">
      <div className="stale-card">
        <h2 id="stale-title">おかえり</h2>
        <p>
          「{session.taskTitle}」を{minutesText(planned)}の予定で始めて、
          {auto ? <>止め忘れていたので<b>予定の{minutesText(planned)}で区切っておきました</b>。</> : <>いま<b>{minutesText(Math.max(planned, elapsedMin))}</b>たっています。</>}
        </p>
        <span className="stale-q">実際はどれくらいやった？</span>
        <div className="stale-choices" role="group" aria-label="実際にやった時間">
          {choices.map((m) => (
            <button key={m} type="button" className={picked === m ? "picked" : ""} aria-pressed={picked === m} onClick={() => setMinutes(m)}>
              {m === planned ? `予定どおり ${minutesText(m)}` : minutesText(m)}
            </button>
          ))}
        </div>
        <label className="stale-time">
          <span>終わった時刻で選ぶ</span>
          <input
            type="time"
            onChange={(e) => {
              const [h, mi] = e.target.value.split(":").map(Number);
              if (!Number.isFinite(h)) return;
              const d = new Date(started);
              d.setHours(h, mi, 0, 0);
              if (d.getTime() < started) d.setDate(d.getDate() + 1);
              const m = Math.round((d.getTime() - started) / MIN - session.pausedTotalSec / 60);
              if (m > 0 && d.getTime() <= now) setMinutes(m);
            }}
          />
        </label>
        <div className="stale-actions">
          <button type="button" className="primary" onClick={() => record(true)}>{minutesText(picked)}で完了</button>
          <button type="button" onClick={() => record(false)}>{minutesText(picked)}・途中まで</button>
        </div>
        <div className="stale-links">
          {!auto && <button type="button" onClick={stillWorking}>まだやってる</button>}
          <button type="button" onClick={notDone}>やってなかった（記録しない）</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
