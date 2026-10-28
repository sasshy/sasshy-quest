import { useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { budgetPeriod, budgetStatus, expenseBucket, BUCKET_LABEL, type BudgetSetting } from "./budget";
import { CATEGORY_COLORS as COLORS, amountOf, spendCategory, type SpendCategory } from "./money";
import { expenseDetail, expensesOn, localDateKey, mealsOn, shiftDateKey } from "./meals";
import { RecordEditSheet } from "./RecordEditSheet";
import type { Memo } from "./types";

/**
 * 記録 › お金 › 日ごと：1週間（月〜日）ずつ。上に毎日の合計の棒（点線＝1日の目安）、
 * 下にその週の1日ずつの明細。左右にスワイプか ‹ › で週を動かす。
 */
const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const label = (key: string) => {
  const d = new Date(`${key}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`;
};
export const timeOf = (m: Memo) => {
  const raw = m.meal ? ((m.meal as { purchaseAt?: string }).purchaseAt || m.meal.at) : (m.expense!.purchaseAt as string | undefined) || m.expense!.at;
  const d = new Date(raw);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

interface Day {
  key: string;
  total: number;
  daily: number;
  records: Memo[];
  cats: { name: SpendCategory; amount: number }[];
}

export function dayOf(memos: Memo[], key: string): Day {
  const records = [...mealsOn(memos, key), ...expensesOn(memos, key)].filter((m) => amountOf(m) > 0);
  records.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  const cats = new Map<SpendCategory, number>();
  let daily = 0;
  for (const m of records) {
    const a = amountOf(m);
    cats.set(spendCategory(m), (cats.get(spendCategory(m)) || 0) + a);
    if (!m.expense || expenseBucket(m) === "daily") daily += a;
  }
  return {
    key,
    total: records.reduce((s, m) => s + amountOf(m), 0),
    daily,
    records,
    cats: [...cats.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
  };
}

export function MoneyWeek({ memos, setting }: { memos: Memo[]; setting: BudgetSetting }) {
  const today = localDateKey(Date.now());
  const [week, setWeek] = useState(0);
  const [open, setOpen] = useState<string | null>(today);
  const [editing, setEditing] = useState<Memo | null>(null);
  const touch = useRef<number | null>(null);
  const cards = useRef<Record<string, HTMLElement | null>>({});

  const monday = useMemo(() => {
    const d = new Date(`${today}T12:00:00`);
    return shiftDateKey(today, -((d.getDay() + 6) % 7) + week * 7);
  }, [today, week]);
  const keys = Array.from({ length: 7 }, (_, i) => shiftDateKey(monday, i));
  const days = keys.map((k) => dayOf(memos, k));
  const period = budgetPeriod(today, setting.startDay);
  // 1日の目安（毎日のお金を期間の日数で割ったもの）。棒の点線とオレンジの判定に使う。
  const target = Math.round(setting.amount / Math.max(1, period.days));
  const past = days.filter((d) => d.key <= today);
  const max = Math.max(target * 1.4, ...days.map((d) => d.total), 1);
  const within = past.filter((d) => d.daily <= target).length;
  const weekCats = new Map<SpendCategory, number>();
  for (const d of past) for (const c of d.cats) weekCats.set(c.name, (weekCats.get(c.name) || 0) + c.amount);
  const topCat = [...weekCats.entries()].sort((a, b) => b[1] - a[1])[0];
  const weekTotal = past.reduce((s, d) => s + d.total, 0);

  const go = (n: number) => {
    if (week + n > 0) return;
    setWeek(week + n);
    setOpen(null);
  };
  const pick = (key: string) => {
    setOpen(key);
    window.setTimeout(() => cards.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };

  return (
    <div className="mw">
      <section
        className="rec-card mw-chart"
        onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touch.current === null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          touch.current = null;
          if (Math.abs(dx) > 50) go(dx > 0 ? -1 : 1);
        }}
      >
        <div className="dm-nav mw-nav">
          <button type="button" aria-label="前の週" onClick={() => go(-1)}>‹</button>
          <strong>{week === 0 ? "今週" : `${label(keys[0]).replace(/（.）/, "")}〜${label(keys[6]).replace(/（.）/, "")}`}</strong>
          <button type="button" aria-label="次の週" disabled={week >= 0} onClick={() => go(1)}>›</button>
        </div>
        <div className="mw-bars" role="list" aria-label="毎日使ったお金">
          <i className="mw-target" style={{ bottom: `calc(30px + ${(target / max).toFixed(4)} * (100% - 46px))` }} aria-hidden="true" />
          {days.map((d) => {
            const future = d.key > today;
            const over = d.daily > target;
            return (
              <button key={d.key} type="button" role="listitem" className={`mw-bar${over ? " over" : ""}${d.key === open ? " on" : ""}${d.key === today ? " today" : ""}`} disabled={future} onClick={() => pick(d.key)} aria-label={`${label(d.key)} ${yen(d.total)}`}>
                <small>{future || !d.total ? "" : d.total >= 10000 ? `${(d.total / 1000).toFixed(0)}k` : d.total.toLocaleString("ja-JP")}</small>
                <span><b style={{ height: `${(d.total / max) * 100}%` }} /></span>
                <em>{WD[new Date(`${d.key}T12:00:00`).getDay()]}<br />{Number(d.key.slice(8))}</em>
              </button>
            );
          })}
        </div>
        <p className="mw-note">点線＝1日平均の目安 {yen(target)}（毎日のお金で数える分）。超えた日はオレンジ</p>
        {past.length > 0 && (
          <p className="mw-verdict">
            {/* 週の評価は一行だけ。責めずに、気づきを1つ。 */}
            目安以内 <b>{within}/{past.length}日</b>・合計 <b>{yen(weekTotal)}</b>
            {topCat && <>・一番多いのは<b>{topCat[0]} {yen(topCat[1])}</b></>}
          </p>
        )}
      </section>

      {[...past].reverse().map((d) => {
        const isOpen = open === d.key;
        return (
          <section key={d.key} ref={(el) => { cards.current[d.key] = el; }} className={`rec-card mw-day${isOpen ? " open" : ""}`}>
            <button type="button" className="mw-day-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : d.key)}>
              <strong>{label(d.key)}{d.key === today && <small>今日</small>}</strong>
              <b className={d.daily > target ? "over" : ""}>{yen(d.total)}</b>
              <ChevronDown size={16} className={isOpen ? "flip" : ""} />
            </button>
            {d.cats.length > 0 ? (
              <div className="mw-chips">
                {d.cats.map((c) => (
                  <span key={c.name} style={{ background: `${COLORS[c.name]}22`, color: COLORS[c.name] }}>{c.name} {yen(c.amount)}</span>
                ))}
              </div>
            ) : (
              <p className="mw-empty">使ったお金はありません</p>
            )}
            {isOpen && d.records.length > 0 && (
              <ul className="mw-list">
                {d.records.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => setEditing(m)}>
                      <time>{timeOf(m)}</time>
                      <i style={{ background: COLORS[spendCategory(m)] }} aria-hidden="true" />
                      <span>
                        {m.meal?.item || m.expense?.item}
                        <small>{spendCategory(m)}{m.expense && expenseBucket(m) !== "daily" ? `・${BUCKET_LABEL[expenseBucket(m)]}` : ""}{expenseDetail(m.expense) ? `・${expenseDetail(m.expense)}` : ""}</small>
                      </span>
                      <b>{yen(amountOf(m))}</b>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {editing && <RecordEditSheet memo={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/**
 * 記録 › お金 › 1日：その日に何にいくら使ったか。‹ › か左右スワイプで1日ずつ。
 */
export function MoneyDay({ memos, setting }: { memos: Memo[]; setting: BudgetSetting }) {
  const today = localDateKey(Date.now());
  // 選んでいないときは「今日」。開いたまま日付が変わっても、古い日に取り残されない。
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked && picked < today ? picked : today;
  const [editing, setEditing] = useState<Memo | null>(null);
  const touch = useRef<number | null>(null);
  const d = dayOf(memos, date);
  const period = budgetPeriod(today, setting.startDay);
  // 今日は、今日の画面と同じ「今日の目安」（残りを残りの日数で割ったもの）。過ぎた日は1日平均。
  const isToday = date === today;
  const target = isToday ? budgetStatus(memos, setting, today).todayAllowance : Math.round(setting.amount / Math.max(1, period.days));
  const targetLabel = isToday ? "今日の目安" : "1日平均の目安";
  const go = (n: number) => {
    const next = shiftDateKey(date, n);
    if (next > today) return;
    setPicked(next >= today ? null : next);
  };
  const maxCat = Math.max(1, ...d.cats.map((c) => c.amount));
  return (
    <div
      className="md"
      onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        touch.current = null;
        if (Math.abs(dx) > 50) go(dx > 0 ? -1 : 1);
      }}
    >
      <section className="rec-card md-head">
        <div className="dm-nav mw-nav">
          <button type="button" aria-label="前の日" onClick={() => go(-1)}>‹</button>
          <strong>{label(date)}{date === today ? " 今日" : ""}</strong>
          <button type="button" aria-label="次の日" disabled={date >= today} onClick={() => go(1)}>›</button>
        </div>
        <div className="md-total">
          <span>この日に使ったお金</span>
          <strong className={d.daily > target ? "over" : ""}>{yen(d.total)}</strong>
          <small>毎日のお金で数える分 {yen(d.daily)}（{targetLabel} {yen(target)}{d.daily > target ? `・${yen(d.daily - target)}オーバー` : ""}）</small>
        </div>
        {d.cats.length > 0 && (
          <ul className="md-cats">
            {d.cats.map((c) => (
              <li key={c.name}>
                <span>{c.name}</span>
                <i><b style={{ width: `${(c.amount / maxCat) * 100}%`, background: COLORS[c.name] }} /></i>
                <strong>{yen(c.amount)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rec-card">
        <header><h2>明細</h2><small>{d.records.length}件</small></header>
        {d.records.length === 0 ? (
          <p className="mw-empty">この日に使ったお金はありません</p>
        ) : (
          <ul className="mw-list md-list">
            {d.records.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => setEditing(m)}>
                  <time>{timeOf(m)}</time>
                  <i style={{ background: COLORS[spendCategory(m)] }} aria-hidden="true" />
                  <span>
                    {m.meal?.item || m.expense?.item}
                    <small>{spendCategory(m)}{m.expense && expenseBucket(m) !== "daily" ? `・${BUCKET_LABEL[expenseBucket(m)]}` : ""}{expenseDetail(m.expense) ? `・${expenseDetail(m.expense)}` : ""}</small>
                  </span>
                  <b>{yen(amountOf(m))}</b>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="md-hint">左右にスワイプで前の日・次の日</p>
      {editing && <RecordEditSheet memo={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
