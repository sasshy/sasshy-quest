import { useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { X } from "lucide-react";
import { DEFAULT_APPEARANCE, getAppearance } from "./appearance";
import { db } from "./db";
import { computeProgress, minutesText, weeklyJars, type WeekJar } from "./progress";
import { Companion } from "./Companion";

/** Today: a ring that fills with work time (goal from settings) + this week's jar of marbles (one per finished task). */
export function TodayProgress() {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const appearance = useLiveQuery(async () => {
    await db.settings.get("appearance");
    return getAppearance();
  }, [], DEFAULT_APPEARANCE) || DEFAULT_APPEARANCE;
  const p = computeProgress(tasks, sessions);
  const jars = weeklyJars(tasks, sessions);
  const [now, last] = [jars[jars.length - 1], jars[jars.length - 2]];
  const [shelf, setShelf] = useState(false);
  const goal = appearance.dailyGoalMin;
  const ratio = Math.min(1, p.workTodayMin / Math.max(1, goal));
  const full = ratio >= 1;
  const C = 2 * Math.PI * 24;
  return (
    <section className={`today-progress${full ? " full" : ""}`} aria-label="今日の積み上がり">
      <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
        <circle cx="30" cy="30" r="24" className="tp-bg" />
        <circle cx="30" cy="30" r="24" className="tp-fg" style={{ strokeDasharray: C, strokeDashoffset: C * (1 - ratio) }} />
      </svg>
      <div className="tp-main">
        <span>{full ? "今日の目標達成" : "今日の作業"}</span>
        <strong className="today-ring-num">
          {minutesText(p.workTodayMin)}
          <small> / {minutesText(goal)}・完了{p.doneToday}件</small>
        </strong>
        <button type="button" className="tp-jar" onClick={() => setShelf(true)} aria-label={`今週のビー玉 ${now.marbles}個。これまでのビンを見る`}>
          <Marbles count={now.marbles} max={20} />
          <small>今週 <b className="xp-num">{now.marbles}</b>個{last.marbles ? `・先週${last.marbles}` : ""}</small>
        </button>
      </div>
      {appearance.companion !== false && <Companion />}
      {shelf && <JarShelf jars={jars} onClose={() => setShelf(false)} />}
    </section>
  );
}

function Marbles({ count, max }: { count: number; max: number }) {
  return (
    <span className="marbles" aria-hidden="true">
      {Array.from({ length: Math.min(count, max) }, (_, i) => <i key={i} className={i === count - 1 ? "new" : ""} />)}
      {count > max && <em>+{count - max}</em>}
      {count === 0 && <em>1件終えると1個入る</em>}
    </span>
  );
}

/** これまでのビン: the last 8 weeks side by side. */
export function JarShelf({ jars, onClose }: { jars: WeekJar[]; onClose: () => void }) {
  const top = Math.max(1, ...jars.map((j) => j.marbles));
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2" role="dialog" aria-modal="true" aria-label="これまでのビン">
        <header>
          <h2 className="qr-title">これまでのビン</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">
        <div className="jar-shelf">
          {jars.map((j, i) => {
            const d = new Date(`${j.start}T12:00:00`);
            const current = i === jars.length - 1;
            return (
              <div key={j.start} className={`jar${current ? " now" : ""}${j.marbles === top && j.marbles > 0 ? " best" : ""}`}>
                <b className="xp-num">{j.marbles}</b>
                <span className="jar-glass">
                  {Array.from({ length: Math.min(j.marbles, 40) }, (_, k) => <i key={k} />)}
                </span>
                <small>{current ? "今週" : `${d.getMonth() + 1}/${d.getDate()}〜`}</small>
                <small className="jar-min">{minutesText(j.minutes)}</small>
              </div>
            );
          })}
        </div>
        <p className="jar-note">1件終えるごとにビー玉が1つ。月曜に新しいビンになります。</p>
        </div>
      </section>
    </div>,
    document.body,
  );
}
