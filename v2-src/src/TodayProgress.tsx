import { useLiveQuery } from "dexie-react-hooks";
import { DEFAULT_APPEARANCE, getAppearance } from "./appearance";
import { db } from "./db";
import { computeProgress, levelFrom, minutesText, xpFrom } from "./progress";

/** Today: a ring that fills with work time (goal from settings) + level/XP that only goes up. */
export function TodayProgress() {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const appearance = useLiveQuery(async () => {
    await db.settings.get("appearance");
    return getAppearance();
  }, [], DEFAULT_APPEARANCE) || DEFAULT_APPEARANCE;
  const p = computeProgress(tasks, sessions);
  const { level, into, need } = levelFrom(xpFrom(p));
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
        <div className="tp-level">
          <b className="xp-num">Lv.{level}</b>
          <i><em style={{ width: `${(into / need) * 100}%` }} /></i>
          <small className="xp-num">{into}/{need} XP</small>
        </div>
      </div>
    </section>
  );
}
