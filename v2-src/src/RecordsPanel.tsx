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
    if (task.deletedAt || task.status !== "done" || !task.completedAt) continue;
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

  const spend = rows.reduce((sum, r) => sum + r.meal + r.other, 0);
  const workMin = rows.reduce((sum, r) => sum + r.workMin, 0);
  const doneCount = rows.reduce((sum, r) => sum + r.done, 0);
  const hasKcal = rows.some((r) => r.kcal > 0);

  // よく使ったもの（期間内、支払った額の多い順）
  const top = useMemo(() => {
    const sums = new Map<string, { name: string; amount: number; count: number }>();
    for (const row of rows) {
      for (const m of ledgerOn(memos, row.key)) {
        const name = m.meal ? m.meal.item : m.expense!.item;
        const amount = m.meal ? paidAmount(m.meal) : Number(m.expense!.amount || 0);
        const current = sums.get(name) || { name, amount: 0, count: 0 };
        current.amount += amount;
        current.count += 1;
        sums.set(name, current);
      }
    }
    return [...sums.values()].filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5);
  }, [rows, memos]);

  const day = rows.find((r) => r.key === selected) || rows[rows.length - 1];
  const dayRecords = ledgerOn(memos, day.key);
  const dayDone = tasks.filter((t) => !t.deletedAt && t.status === "done" && t.completedAt && localDateKey(t.completedAt) === day.key);

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
          <span>支払い</span>
          <strong>{yen(spend)}</strong>
          <small>1日平均 {yen(spend / range)}</small>
        </div>
        <div>
          <span>作業した時間</span>
          <strong>{hoursText(workMin)}</strong>
          <small>完了 {doneCount}件</small>
        </div>
      </section>

      <section className="rec-card">
        <header>
          <h2>1日の支払い</h2>
          <div className="rec-legend">
            <span><i className="seg-meal" />食事</span>
            <span><i className="seg-other" />その他</span>
          </div>
        </header>
        <BarChart
          rows={rows}
          label="1日の支払い"
          segments={[
            { key: "meal", name: "食事", className: "seg-meal" },
            { key: "other", name: "その他", className: "seg-other" },
          ]}
          selected={day.key}
          onSelect={setSelected}
          format={(v) => (v >= 1000 ? `¥${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `¥${Math.round(v)}`)}
        />
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

      {hasKcal && (
        <section className="rec-card">
          <header>
            <h2>カロリー</h2>
          </header>
          <BarChart
            rows={rows}
            label="カロリー"
            segments={[{ key: "kcal", name: "カロリー", className: "seg-kcal" }]}
            selected={day.key}
            onSelect={setSelected}
            format={(v) => `${Math.round(v).toLocaleString("ja-JP")}`}
          />
        </section>
      )}

      <section className="rec-card rec-day">
        <header>
          <h2>
            {dayLabel(day.key)}({weekday(day.key)}){day.key === today ? " 今日" : ""}
          </h2>
          <small>グラフの棒を押すとその日を表示</small>
        </header>
        <dl className="rec-day-sum">
          <div><dt>支払い</dt><dd>{yen(day.meal + day.other)}</dd></div>
          <div><dt>作業</dt><dd>{hoursText(day.workMin)}</dd></div>
          <div><dt>完了</dt><dd>{day.done}件</dd></div>
          {day.kcal > 0 && <div><dt>カロリー</dt><dd>{day.kcal.toLocaleString("ja-JP")}kcal</dd></div>}
        </dl>
        {dayRecords.length > 0 && (
          <>
            <h3>食事・支出</h3>
            <ul className="rec-list">
              {dayRecords.map((m) => {
                return <RecordRow key={m.id} memo={m} />;
              })}
            </ul>
          </>
        )}
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
        {dayRecords.length === 0 && dayDone.length === 0 && <p className="rec-empty">この日の記録はありません</p>}
      </section>

      {top.length > 0 && (
        <section className="rec-card">
          <header>
            <h2>お金を使ったもの（{range === 7 ? "1週間" : "1ヶ月"}）</h2>
          </header>
          <ul className="rec-top">
            {top.map((item) => (
              <li key={item.name}>
                <span className="rec-name">{item.name}</span>
                <small>{item.count}回</small>
                <span className="rec-top-bar"><i style={{ width: `${(item.amount / top[0].amount) * 100}%` }} /></span>
                <span className="rec-amount">{yen(item.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      </>)}
      {mealsOn(memos, today).length === 0 && expensesOn(memos, today).length === 0 && (
        <p className="rec-hint">食事・支出は「今日」の「食事・支出を記録」から追加できます。</p>
      )}
      </>)}
    </div>
  );
}

/** 今日：いくら使ったかを一番大きく。昨日・1週間平均と並べる。 */
function TodaySummary({ memos, tasks, sessions, week, today }: { memos: Memo[]; tasks: Task[]; sessions: FocusSession[]; week: DayRow[]; today: string }) {
  const progress = computeProgress(tasks, sessions);
  const todayRow = week[week.length - 1];
  const yesterday = week[week.length - 2];
  const past7 = week.slice(0, 7);
  const avg = past7.reduce((sum, r) => sum + r.meal + r.other, 0) / 7;
  const total = todayRow.meal + todayRow.other;
  const records = ledgerOn(memos, today);
  const done = tasks.filter((t) => !t.deletedAt && t.status === "done" && t.completedAt && localDateKey(t.completedAt) === today);
  const diff = total - avg;
  return (
    <>
      <section className="rec-hero">
        <span>今日使ったお金</span>
        <strong>{yen(total)}</strong>
        <div className="rec-hero-split">
          <span><i className="seg-meal" />食事 {yen(todayRow.meal)}</span>
          <span><i className="seg-other" />その他 {yen(todayRow.other)}</span>
        </div>
        <div className="rec-hero-compare">
          <div><small>昨日</small><b>{yen(yesterday.meal + yesterday.other)}</b></div>
          <div><small>1週間の平均</small><b>{yen(avg)}</b></div>
          <div><small>平均との差</small><b className={diff > 0 ? "up" : "down"}>{diff > 0 ? "+" : diff < 0 ? "−" : "±"}{yen(Math.abs(diff))}</b></div>
        </div>
      </section>
      <section className="rec-card">
        <header><h2>今日の内訳</h2><small>{records.length}件</small></header>
        {records.length ? (
          <ul className="rec-list">
            {records.map((m) => {
              return <RecordRow key={m.id} memo={m} />;
            })}
          </ul>
        ) : (
          <p className="rec-empty">まだ記録がありません</p>
        )}
      </section>
      <section className="rec-tiles">
        <div>
          <span>今日作業した時間</span>
          <strong>{hoursText(todayRow.workMin)}</strong>
          <small>完了 {done.length}件</small>
        </div>
        <div>
          <span>カロリー</span>
          <strong>{todayRow.kcal ? `${todayRow.kcal.toLocaleString("ja-JP")}` : "—"}</strong>
          <small>kcal（記録がある分）</small>
        </div>
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
    .filter((t) => !t.deletedAt && t.status === "done" && t.completedAt && localDateKey(t.completedAt) >= start)
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const work = rows.reduce((sum, r) => sum + r.workMin, 0);
  const recordDays = rows.filter((r) => r.meal + r.other > 0).length;
  return (
    <section className="rec-weekdone">
      <span>この1週間でできたこと</span>
      <div className="rec-weekdone-nums">
        <div><strong>{done.length}</strong><small>件 完了</small></div>
        <div><strong>{minutesText(work)}</strong><small>作業</small></div>
        <div><strong>{recordDays}</strong><small>日 記録</small></div>
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
