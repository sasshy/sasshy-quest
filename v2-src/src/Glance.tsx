import { useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { CalendarDays, Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { emptyGoogleCalendar, getGoogleCalendarConfig } from "./google-calendar";
import { DEFAULT_APPEARANCE, getAppearance } from "./appearance";
import { db } from "./db";
import { computeProgress, minutesText, weeklyJars } from "./progress";
import { Companion } from "./Companion";
import { JarShelf } from "./TodayProgress";
import { BudgetSheet, useBudget, useCountTo } from "./BudgetPanel";
import { DEFAULT_TIME_LEFT, getTimeLeft, timeLeftItems } from "./timeleft";
import { DayBlocks, TimeLeftEditor, useNow } from "./TimeLeftPanel";
import { WHEN_LABEL, habits, inWindow, setHabitDay } from "./habits";
import { createTask } from "./store";
import { ruleDay, yenText } from "./habit-rules";
import { localDateKey } from "./meals";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import type { Memo, Task } from "./types";

const yen = (value: number) => `¥${Math.abs(Math.round(value)).toLocaleString("ja-JP")}`;

/**
 * 今日のひと目：開いてすぐ見たい「作業・使えるお金・ねこ・寝るまでの残り」を
 * 1枚にまとめる。数字はそれぞれ見出しの下に1つだけ置き、何の数字か迷わせない。
 */
export function TodayGlance() {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const appearance = useLiveQuery(async () => {
    await db.settings.get("appearance");
    return getAppearance();
  }, [], DEFAULT_APPEARANCE) || DEFAULT_APPEARANCE;
  const timeLeft = useLiveQuery(async () => {
    await db.settings.get("timeLeft");
    return getTimeLeft();
  }, [], DEFAULT_TIME_LEFT) || DEFAULT_TIME_LEFT;
  const { setting: budget, status, shopping } = useBudget();
  const money = useCountTo(status.todayLeft);
  const now = useNow();
  const [shelf, setShelf] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editingTime, setEditingTime] = useState(false);

  const p = computeProgress(tasks, sessions);
  const jars = weeklyJars(tasks, sessions);
  const goal = appearance.dailyGoalMin;
  const ratio = Math.min(1, p.workTodayMin / Math.max(1, goal));
  const over = status.todayLeft < 0;
  const items = timeLeft.enabled ? timeLeftItems(timeLeft, now) : [];
  const day = items.find((it) => it.key === "day");
  const rest = items.filter((it) => it.key !== "day");
  const cat = appearance.companion !== false;

  return (
    <section className={`glance${cat ? " with-cat" : ""}${budget.enabled ? "" : " no-money"}`} aria-label="今日のようす">
      <div className="glance-top">
        <button type="button" className={`glance-tile${ratio >= 1 ? " full" : ""}`} onClick={() => setShelf(true)} aria-label="今日の作業。今週のビー玉を見る">
          <span className="glance-label">{ratio >= 1 ? "今日の目標達成" : "今日の作業"}</span>
          <strong className="glance-num">{minutesText(p.workTodayMin)}</strong>
          <i className="glance-bar" aria-hidden="true"><b style={{ width: `${Math.round(ratio * 100)}%` }} /></i>
          <small>完了{p.doneToday}件</small>
          <small>目標{minutesText(goal)}</small>
        </button>
        {budget.enabled && (
          <button type="button" className={`glance-tile money${over ? " over" : ""}`} onClick={() => setBudgetOpen(true)} aria-label="今日あと使えるお金。予算を開く">
            {/* 超えたときは「目安いくらに対して、いくら超えたか」を見出しと数字で出す。 */}
            <span className="glance-label">{over ? `今日の目安 ${yen(status.todayAllowance)}` : "今日あと使える"}</span>
            <strong className="glance-num">{over ? "+" : ""}{yen(money)}</strong>
            {over ? (
              <>
                <small className="over">目安オーバー</small>
                <small>使った {yen(status.spentToday)}</small>
              </>
            ) : (
              <>
                <small>今日の目安 {yen(status.todayAllowance)}</small>
                <small className={shopping.left < 0 ? "over" : ""}>買い物枠 {shopping.left < 0 ? "−" : ""}{yen(shopping.left)}</small>
              </>
            )}
          </button>
        )}
        {cat && <div className="glance-cat"><Companion /></div>}
      </div>

      {day && <DayBlocks item={day} now={now.getTime()} />}

      {rest.length > 0 && (
        <div className="glance-more">
          <button type="button" className="glance-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            <span>{rest.slice(0, 3).map((it) => `${it.label}あと${it.value}${it.unit}`).join("・")}</span>
            <ChevronDown size={15} className={moreOpen ? "flip" : ""} />
          </button>
          {moreOpen && (
            <>
              <ul className="tl-list">
                {rest.map((it) => {
                  const left = Math.round((1 - it.used) * 100);
                  return (
                    <li key={it.key} className={it.low ? "low" : ""} title={it.note}>
                      <span className="tl-label">{it.label}</span>
                      <i className="tl-bar" aria-hidden="true"><b style={{ width: `${left}%` }} /></i>
                      <strong className="tl-num">{it.value}<small>{it.unit}</small>{it.extra && <em>{it.extra}</em>}</strong>
                    </li>
                  );
                })}
              </ul>
              <button type="button" className="glance-set" onClick={() => setEditingTime(true)}>
                <SlidersHorizontal size={13} /> 残り時間の設定
              </button>
            </>
          )}
        </div>
      )}

      {shelf && <JarShelf jars={jars} onClose={() => setShelf(false)} />}
      {budgetOpen && createPortal(<BudgetSheet onClose={() => setBudgetOpen(false)} />, document.body)}
      {editingTime && createPortal(<TimeLeftEditor setting={timeLeft} onClose={() => setEditingTime(false)} />, document.body)}
    </section>
  );
}

/**
 * 今日の画面の習慣：まだのものだけを並べ、終わったものは数に回して消える。
 * 増えても縦に伸びすぎないよう、まだのものは最大4つ＋「ほか◯」。
 */
export function TodayHabits() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const [all, setAll] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const list = habits(memos);
  const today = localDateKey(Date.now());
  if (!list.length) return null;
  const rows = list.map((h) => {
    const rule = h.habit!.rule;
    const r = rule ? ruleDay(h, memos, today) : null;
    const done = r ? r.state === "done" : h.habit!.days.includes(today);
    return { h, rule, r, done, pending: r?.state === "pending", over: r?.state === "over" };
  });
  // 自動の習慣は今日がまだ途中（pending）なら「まだ」に並べて金額を見せる。
  // 超えてしまった日（×）はもうできることがないので、「まだ」からは外して数だけ出す。
  const left = rows.filter((x) => !x.done && !x.over);
  const doneRows = rows.filter((x) => x.done || x.over);
  const doneCount = rows.filter((x) => x.done).length;
  const overCount = rows.filter((x) => x.over).length;
  const shown = all ? left : left.slice(0, 4);
  const toggle = async (h: Memo, on: boolean) => {
    if (on) haptic("success");
    await setHabitDay(h, today, on);
    syncNow().catch(() => undefined);
  };
  const openHabits = () => {
    window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "records" }));
    window.dispatchEvent(new Event("sasshy-open-habits"));
  };
  return (
    <section className={`today-habits${left.length === 0 ? " all-done" : ""}`} aria-label="今日の習慣">
      <div className="today-habits-label">
        <button type="button" onClick={openHabits}>今日の習慣 ›</button>
        {/* 数を押すと、終わったものが出る（間違えて✓したら、そこで外せる）。 */}
        <button type="button" className="th-count" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
          {left.length === 0 && overCount === 0 ? "ぜんぶ✓" : `✓${doneCount}${overCount ? ` ×${overCount}` : ""} / ${rows.length}`}
          <ChevronDown size={13} className={showDone ? "flip" : ""} />
        </button>
      </div>
      {left.length > 0 && (
        <div className="today-habits-row">
          {shown.map(({ h, rule, r, over }) => (
            <button
              key={h.id}
              type="button"
              className={`th-chip${over ? " over" : ""}${rule ? " auto" : ""}`}
              onClick={() => { if (!rule) toggle(h, true); }}
            >
              <i aria-hidden="true">{over ? "×" : ""}</i>
              <span>{h.habit!.name}</span>
              {rule && r && <small>{yenText(r.spent)}/{yenText(rule.limit)}</small>}
            </button>
          ))}
          {left.length > 4 && (
            <button type="button" className="th-more" onClick={() => setAll(!all)}>{all ? "たたむ" : `ほか${left.length - 4}`}</button>
          )}
        </div>
      )}
      {showDone && doneRows.length > 0 && (
        <div className="today-habits-row th-done">
          {doneRows.map(({ h, rule, r, over }) => (
            <button key={h.id} type="button" className={`th-chip${over ? " over" : " done"}${rule ? " auto" : ""}`} onClick={() => { if (!rule) toggle(h, false); }}>
              <i aria-hidden="true">{over ? "×" : <Check size={12} strokeWidth={3} />}</i>
              <span>{h.habit!.name}</span>
              {rule && r ? <small>{yenText(r.spent)}/{yenText(rule.limit)}</small> : <small>押すと外す</small>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 今日の予定（Googleカレンダー）：これからの予定だけを、今日の画面の上に1行で。
 * 次の予定は「あと◯分」も出す。終わった予定は出さない。
 */
export function TodayEvents() {
  const config = useLiveQuery(() => getGoogleCalendarConfig(), [], emptyGoogleCalendar) || emptyGoogleCalendar;
  const now = useNow();
  if (!config.enabled) return null;
  const today = localDateKey(now.getTime());
  const list = config.events
    .filter((e) => (e.allDay ? e.start <= today && (e.end ? e.end > today : e.start === today) : localDateKey(Date.parse(e.start)) === today))
    .filter((e) => e.allDay || Date.parse(e.end || e.start) > now.getTime())
    .sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
  if (!list.length) return null;
  const hmOf = (iso: string) => {
    const d = new Date(iso);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const next = list.find((e) => !e.allDay);
  const until = next ? Math.round((Date.parse(next.start) - now.getTime()) / 60_000) : null;
  return (
    <button type="button" className="today-events" onClick={() => window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "calendar" }))} aria-label="今日の予定（カレンダーを開く）">
      <CalendarDays size={16} aria-hidden="true" />
      <span className="te-list">
        {list.slice(0, 3).map((e) => (
          <span key={e.id} className={e === next ? "next" : ""}>
            <b>{e.allDay ? "終日" : hmOf(e.start)}</b>{e.title}
          </span>
        ))}
        {list.length > 3 && <small>ほか{list.length - 3}件</small>}
      </span>
      {next && until !== null && <em>{until <= 0 ? "今" : until < 60 ? `あと${until}分` : `あと${Math.floor(until / 60)}時間${until % 60 ? `${until % 60}分` : ""}`}</em>}
    </button>
  );
}

/**
 * 今の時間の習慣：「いつやるか」を決めた習慣が、その時間帯になったら今日のリストの上に出る。
 * 「次はこれ」（仕事）には入れない。✓か「2分だけ」で始められる。
 */
export function NowHabits({ onStart }: { onStart: (task: Task, opts: { starter?: boolean }) => void }) {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const now = useNow(60_000);
  const today = localDateKey(now.getTime());
  const due = habits(memos).filter((h) => h.habit!.when && !h.habit!.rule && inWindow(h.habit!.when, now) && !h.habit!.days.includes(today));
  if (!due.length) return null;
  return (
    <section className="now-habits" aria-label="今の時間の習慣">
      <span className="now-habits-label">今の時間の習慣（{WHEN_LABEL[due[0].habit!.when!]}）</span>
      {due.map((h) => (
        <div key={h.id} className="now-habit">
          <strong>{h.habit!.name}</strong>
          <button type="button" className="nh-start" onClick={async () => {
            // 2分だけ：その場でタスクにして始める（終えると習慣にも✓が付く）。
            const task = await createTask({ title: h.habit!.name, scheduledDate: today, estimateMin: 2, durationMin: 2 });
            onStart(task, { starter: true });
          }}>2分だけ</button>
          <button type="button" className="nh-done" aria-label={`${h.habit!.name}をやった`} onClick={async () => {
            haptic("success");
            await setHabitDay(h, today, true);
            syncNow().catch(() => undefined);
          }}><Check size={16} strokeWidth={3} /></button>
        </div>
      ))}
    </section>
  );
}
