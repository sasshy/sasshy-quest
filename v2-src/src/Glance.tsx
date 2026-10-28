import { useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { DEFAULT_APPEARANCE, getAppearance } from "./appearance";
import { db } from "./db";
import { computeProgress, minutesText, weeklyJars } from "./progress";
import { Companion } from "./Companion";
import { JarShelf } from "./TodayProgress";
import { BudgetSheet, useBudget, useCountTo } from "./BudgetPanel";
import { DEFAULT_TIME_LEFT, getTimeLeft, timeLeftItems } from "./timeleft";
import { DayBlocks, TimeLeftEditor, useNow } from "./TimeLeftPanel";
import { habits, setHabitDay } from "./habits";
import { ruleDay, yenText } from "./habit-rules";
import { localDateKey } from "./meals";
import { syncNow } from "./sync";
import { haptic } from "./feedback";

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

/** 今日の画面の習慣の1行：押せばその場で✓。自動の習慣は今日の金額を出す。 */
export function TodayHabits() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const list = habits(memos);
  const today = localDateKey(Date.now());
  if (!list.length) return null;
  return (
    <section className="today-habits" aria-label="今日の習慣">
      <span className="today-habits-label">習慣</span>
      <div className="today-habits-row">
        {list.map((h) => {
          const rule = h.habit!.rule;
          const r = rule ? ruleDay(h, memos, today) : null;
          const done = r ? r.state === "done" || r.state === "pending" : h.habit!.days.includes(today);
          const over = r?.state === "over";
          return (
            <button
              key={h.id}
              type="button"
              className={`th-chip${done ? " done" : ""}${over ? " over" : ""}${rule ? " auto" : ""}`}
              aria-pressed={done}
              onClick={async () => {
                if (rule) return;
                if (!done) haptic("success");
                await setHabitDay(h, today, !done);
                syncNow().catch(() => undefined);
              }}
            >
              <i aria-hidden="true">{done ? <Check size={12} strokeWidth={3} /> : over ? "×" : ""}</i>
              {h.habit!.name}
              {rule && r && <small>{yenText(r.spent)}/{yenText(rule.limit)}</small>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
