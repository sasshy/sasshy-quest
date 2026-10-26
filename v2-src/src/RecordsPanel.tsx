import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { DiaryMonth, peekDiaryRequest, takeDiaryRequest } from "./DiaryPanel";
import { RecordEditSheet } from "./RecordEditSheet";
import { HabitsPanel } from "./HabitsPanel";
import { MealsLog } from "./MealsLog";
import { MoneyPanel } from "./MoneyPanel";
import { sessionActiveSeconds } from "./insights";
import {
  MEAL_LABEL,
  expensesOn,
  kcalOn,
  ledgerOn,
  localDateKey,
  mealsOn,
  paidAmount,
  shiftDateKey,
  spendOn,
} from "./meals";
import type { FocusSession, Memo, Task } from "./types";
import { computeProgress, minutesText } from "./progress";

/**
 * 記録: meals, spends and work time over the last 7 / 30 days.
 * Bars are tappable; the chosen day is listed below (that list is also the
 * table view for the charts).
 */
type Range = 1 | 7 | 30;

interface DayRow {
  key: string;
  meal: number;
  other: number;
  kcal: number;
  workMin: number;
  done: number;
}

const yen = (value: number) => `¥${Math.round(value).toLocaleString("ja-JP")}`;
const dayLabel = (key: string) => {
  const d = new Date(`${key}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const weekday = (key: string) =>
  new Date(`${key}T12:00:00`).toLocaleDateString("ja-JP", { weekday: "short" });
const hoursText = (min: number) =>
  min >= 60 ? `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`;

export function buildDayRows(memos: Memo[], sessions: FocusSession[], tasks: Task[], days: number, today: string): DayRow[] {
  const keys = Array.from({ length: days }, (_, i) => shiftDateKey(today, i - days + 1));
  const work = new Map<string, number>();
  for (const session of sessions) {
    const sec = sessionActiveSeconds(session);
    if (!sec || !session.endedAt) continue;
    const key = localDateKey(session.endedAt);
    work.set(key, (work.get(key) || 0) + sec);
  }
  const done = new Map<string, number>();
  for (const task of tasks) {
    if (task.deletedAt || task.log || task.status !== "done" || !task.completedAt) continue;
    const key = localDateKey(task.completedAt);
    done.set(key, (done.get(key) || 0) + 1);
  }
  return keys.map((key) => ({
    key,
    meal: spendOn(memos, key),
    other: expensesOn(memos, key).reduce((sum, m) => sum + Number(m.expense!.amount || 0), 0),
    kcal: kcalOn(memos, key),
    workMin: Math.round((work.get(key) || 0) / 60),
    done: done.get(key) || 0,
  }));
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
}

function BarChart({
  rows,
  segments,
  selected,
  onSelect,
  format,
  label,
}: {
  rows: DayRow[];
  segments: { key: keyof DayRow; name: string; className: string }[];
  selected: string;
  onSelect: (key: string) => void;
  format: (value: number) => string;
  label: string;
}) {
  const totals = rows.map((row) => segments.reduce((sum, s) => sum + Number(row[s.key]), 0));
  const max = niceMax(Math.max(...totals));
  const dense = rows.length > 10;
  return (
    <div className="rec-chart" role="group" aria-label={label}>
      <div className="rec-axis">
        <span>{format(max)}</span>
        <span>{format(max / 2)}</span>
        <span>0</span>
      </div>
      <div className={`rec-bars${dense ? " dense" : ""}`}>
        <div className="rec-grid" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {rows.map((row, i) => (
          <button
            key={row.key}
            type="button"
            className={`rec-bar${row.key === selected ? " selected" : ""}`}
            aria-label={`${dayLabel(row.key)} ${format(totals[i])}`}
            title={`${dayLabel(row.key)}(${weekday(row.key)}) ${segments.map((s) => `${s.name} ${format(Number(row[s.key]))}`).join(" / ")}`}
            onClick={() => onSelect(row.key)}
          >
            <span className="rec-stack" style={{ height: `${(totals[i] / max) * 100}%` }}>
              {segments.map((s) =>
                Number(row[s.key]) > 0 ? (
                  <span key={s.key} className={s.className} style={{ flexGrow: Number(row[s.key]) }} />
                ) : null,
              )}
            </span>
            <small>{dense ? ((rows.length - 1 - i) % 7 === 0 ? dayLabel(row.key) : "") : weekday(row.key)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export function RecordsPanel() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const today = localDateKey(Date.now());
  const [range, setRange] = useState<Range>(1);
  const [view, setView] = useState<"money" | "stats" | "meals" | "diary" | "habits">(() => (peekDiaryRequest() ? "diary" : "money"));
  useEffect(() => {
    takeDiaryRequest();
    const open = () => { takeDiaryRequest(); setView("diary"); };
    const openHabits = () => setView("habits");
    window.addEventListener("sasshy-open-diary", open);
    window.addEventListener("sasshy-open-habits", openHabits);
    return () => { window.removeEventListener("sasshy-open-diary", open); window.removeEventListener("sasshy-open-habits", openHabits); };
  }, []);
  const [selected, setSelected] = useState(today);
  const rows = useMemo(() => buildDayRows(memos, sessions, tasks, range, today), [memos, sessions, tasks, range, today]);
  // 今日と比べる用（昨日・直近1週間の平均）
  const week = useMemo(() => buildDayRows(memos, sessions, tasks, 8, today), [memos, sessions, tasks, today]);

  const workMin = rows.reduce((sum, r) => sum + r.workMin, 0);
  const doneCount = rows.reduce((sum, r) => sum + r.done, 0);

  const day = rows.find((r) => r.key === selected) || rows[rows.length - 1];
  const dayDone = tasks.filter((t) => !t.deletedAt && !t.log && t.status === "done" && t.completedAt && localDateKey(t.completedAt) === day.key);

  return (
    <div className="page-content records-page">
      <div className="rec-view" role="tablist" aria-label="見るもの">
        <button type="button" role="tab" aria-selected={view === "money"} className={view === "money" ? "active" : ""} onClick={() => setView("money")}>お金</button>
        <button type="button" role="tab" aria-selected={view === "stats"} className={view === "stats" ? "active" : ""} onClick={() => setView("stats")}>作業</button>
        <button type="button" role="tab" aria-selected={view === "meals"} className={view === "meals" ? "active" : ""} onClick={() => setView("meals")}>食事</button>
        <button type="button" role="tab" aria-selected={view === "diary"} className={view === "diary" ? "active" : ""} onClick={() => setView("diary")}>日記</button>
        <button type="button" role="tab" aria-selected={view === "habits"} className={view === "habits" ? "active" : ""} onClick={() => setView("habits")}>習慣</button>
      </div>
      {view === "habits" ? <HabitsPanel /> : view === "meals" ? <MealsLog /> : view === "diary" ? <DiaryMonth /> : view === "money" ? <MoneyPanel /> : (<>
      <div className="rec-range" role="group" aria-label="期間">
        {([1, 7, 30] as Range[]).map((value) => (
          <button key={value} type="button" className={range === value ? "active" : ""} onClick={() => { setRange(value); setSelected(today); }}>
            {value === 1 ? "今日" : value === 7 ? "1週間" : "1ヶ月"}
          </button>
        ))}
      </div>
      {range === 1 ? <TodaySummary memos={memos} tasks={tasks} sessions={sessions} week={week} today={today} /> : (<>
      {range === 7 && <WeekDone tasks={tasks} rows={rows} />}

      <section className="rec-tiles">
        <div>
          <span>作業した時間</span>
          <strong>{hoursText(workMin)}</strong>
          <small>1日平均 {hoursText(Math.round(workMin / range))}</small>
        </div>
        <div>
          <span>完了したこと</span>
          <strong>{doneCount}件</strong>
          <small>1日平均 {Math.round((doneCount / range) * 10) / 10}件</small>
        </div>
      </section>

      <section className="rec-card">
        <header>
          <h2>作業した時間</h2>
        </header>
        <BarChart
          rows={rows}
          label="作業した時間"
          segments={[{ key: "workMin", name: "作業", className: "seg-work" }]}
          selected={day.key}
          onSelect={setSelected}
          format={(v) => (v >= 60 ? `${Math.round((v / 60) * 10) / 10}h` : `${Math.round(v)}分`)}
        />
      </section>

      <section className="rec-card rec-day">
        <header>
          <h2>
            {dayLabel(day.key)}({weekday(day.key)}){day.key === today ? " 今日" : ""}
          </h2>
          <small>グラフの棒を押すとその日を表示</small>
        </header>
        <dl className="rec-day-sum">
          <div><dt>作業</dt><dd>{hoursText(day.workMin)}</dd></div>
          <div><dt>完了</dt><dd>{day.done}件</dd></div>
        </dl>
        {dayDone.length > 0 && (
          <>
            <h3>完了したこと</h3>
            <ul className="rec-list">
              {dayDone.map((t) => (
                <li key={t.id}>
                  <span className="rec-time">{new Date(t.completedAt!).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="rec-name">{t.title}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {dayDone.length === 0 && <p className="rec-empty">この日に完了したことはまだありません</p>}
      </section>

      </>)}
      </>)}
    </div>
  );
}

/** 今日：作業した時間と、できたこと。お金は「お金」、カロリーは「食事」のタブへ。 */
function TodaySummary({ tasks, sessions, week, today }: { memos: Memo[]; tasks: Task[]; sessions: FocusSession[]; week: DayRow[]; today: string }) {
  const progress = computeProgress(tasks, sessions);
  const todayRow = week[week.length - 1];
  const past7 = week.slice(0, 7);
  const avg = past7.reduce((sum, r) => sum + r.workMin, 0) / 7;
  const done = tasks
    .filter((t) => !t.deletedAt && !t.log && t.status === "done" && t.completedAt && localDateKey(t.completedAt) === today)
    .sort((a, b) => (a.completedAt || "").localeCompare(b.completedAt || ""));
  return (
    <>
      <section className="rec-hero">
        <span>今日作業した時間</span>
        <strong>{hoursText(todayRow.workMin)}</strong>
        <div className="rec-hero-compare">
          <div><small>完了</small><b>{done.length}件</b></div>
          <div><small>1週間の平均</small><b>{hoursText(Math.round(avg))}</b></div>
          <div><small>昨日</small><b>{hoursText(week[week.length - 2].workMin)}</b></div>
        </div>
      </section>
      <section className="rec-card">
        <header><h2>今日できたこと</h2><small>{done.length}件</small></header>
        {done.length ? (
          <ul className="rec-list">
            {done.map((t) => (
              <li key={t.id}>
                <span className="rec-time">{new Date(t.completedAt!).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
                <span className="rec-name">{t.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rec-empty">まだありません。1つ終えたらここに並びます</p>
        )}
      </section>
      <section className="rec-stack-up">
        <header><h2>積み上がり</h2><small>減らない数字です</small></header>
        <div>
          <div><span>今月の作業</span><strong>{minutesText(progress.workMonthMin)}</strong></div>
          <div><span>これまでの作業</span><strong>{minutesText(progress.workTotalMin)}</strong></div>
          <div><span>完了したこと</span><strong>{progress.doneTotal.toLocaleString("ja-JP")}件</strong></div>
        </div>
      </section>
    </>
  );
}

/** 1週間：今週できたこと（責めるためではなく、やったことを見える形に）。 */
function WeekDone({ tasks, rows }: { tasks: Task[]; rows: DayRow[] }) {
  const start = rows[0].key;
  const done = tasks
    .filter((t) => !t.deletedAt && !t.log && t.status === "done" && t.completedAt && localDateKey(t.completedAt) >= start)
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const work = rows.reduce((sum, r) => sum + r.workMin, 0);
  const workDays = rows.filter((r) => r.workMin > 0).length;
  return (
    <section className="rec-weekdone">
      <span>この1週間でできたこと</span>
      <div className="rec-weekdone-nums">
        <div><strong>{done.length}</strong><small>件 完了</small></div>
        <div><strong>{minutesText(work)}</strong><small>作業</small></div>
        <div><strong>{workDays}</strong><small>日 作業した</small></div>
      </div>
      {done.length > 0 && (
        <ul>
          {done.slice(0, 5).map((t) => <li key={t.id}>✓ {t.title}</li>)}
          {done.length > 5 && <li className="more">ほか{done.length - 5}件</li>}
        </ul>
      )}
    </section>
  );
}

/** One meal / spend line; tap to fix it. */
function RecordRow({ memo }: { memo: Memo }) {
  const [open, setOpen] = useState(false);
  const at = memo.meal?.at || memo.expense!.at;
  return (
    <li>
      <button type="button" className="rec-row" onClick={() => setOpen(true)}>
        <span className="rec-time">{new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
        <span className={`rec-tag ${memo.meal ? "meal" : "other"}`}>{memo.meal ? MEAL_LABEL[memo.meal.kind] : "支出"}</span>
        <span className="rec-name">{memo.meal ? memo.meal.item : memo.expense!.item}</span>
        <span className="rec-amount">{memo.meal ? (memo.meal.price !== null ? yen(paidAmount(memo.meal)) : "—") : yen(Number(memo.expense!.amount))}</span>
      </button>
      {open && <RecordEditSheet memo={memo} onClose={() => setOpen(false)} />}
    </li>
  );
}
