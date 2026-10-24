import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, MoreHorizontal, Plus } from "lucide-react";
import { db } from "./db";
import { archiveHabit, countIn, createHabit, habits, renameHabit, setHabitDay } from "./habits";
import { localDateKey } from "./meals";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import type { Memo } from "./types";

/** 記録 › 習慣: tap ✓ for today, see the month as a calendar per habit. */
export function HabitsPanel() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const list = habits(memos);
  const today = localDateKey(Date.now());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const keys = Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const toggle = async (memo: Memo, date: string) => {
    const done = !memo.habit!.days.includes(date);
    if (done) haptic("success");
    await setHabitDay(memo, date, done);
    syncNow().catch(() => undefined);
  };

  return (
    <div className="habits">
      <section className="hb-today">
        <header>
          <h2>今日の習慣</h2>
          <small>押すと✓。続かなくても大丈夫、数えるのは「今月◯回」だけ</small>
        </header>
        {list.length === 0 && <p className="hb-empty">まだ習慣がありません。下から足すか、ルーティンを最後までやると自動でできます。</p>}
        <div className="hb-checks">
          {list.map((h) => {
            const done = h.habit!.days.includes(today);
            return (
              <button key={h.id} type="button" className={`hb-check${done ? " done" : ""}`} aria-pressed={done} onClick={() => toggle(h, today)}>
                <span className="hb-box">{done && <Check size={18} strokeWidth={3} />}</span>
                <span className="hb-name">{h.habit!.name}</span>
                <small>今月{countIn(h, today.slice(0, 7))}回</small>
              </button>
            );
          })}
        </div>
        <form className="wish-add" onSubmit={async (e) => {
          e.preventDefault();
          const typed = String(new FormData(e.currentTarget).get("habit") || "").trim();
          if (!typed) return;
          await createHabit(typed);
          setDraft("");
          syncNow().catch(() => undefined);
        }}>
          <input name="habit" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="習慣を足す（例：0時までに寝る・筋トレ1分）" />
          <button className="button primary" type="submit" aria-label="習慣を足す"><Plus size={18} /></button>
        </form>
      </section>

      <div className="dm-nav hb-nav">
        <button type="button" aria-label="前の月" onClick={() => shift(-1)}>‹</button>
        <strong>{y}年{m}月</strong>
        <button type="button" aria-label="次の月" disabled={month >= today.slice(0, 7)} onClick={() => shift(1)}>›</button>
      </div>

      {list.map((h) => (
        <section key={h.id} className="hb-card">
          <header>
            <strong>{h.habit!.name}</strong>
            <span className="hb-count">{countIn(h, month)}<small>回</small></span>
            <button type="button" className="hb-more" aria-label={`${h.habit!.name}の設定`} onClick={() => setMenu(menu === h.id ? null : h.id)}><MoreHorizontal size={18} /></button>
          </header>
          {menu === h.id && (
            <div className="hb-menu">
              <button type="button" onClick={async () => { const name = window.prompt("新しい名前", h.habit!.name); if (name) { await renameHabit(h, name); syncNow().catch(() => undefined); } setMenu(null); }}>名前を変える</button>
              <button type="button" className="danger" onClick={async () => { if (window.confirm(`「${h.habit!.name}」をしまいますか？（記録は残ります）`)) { await archiveHabit(h); syncNow().catch(() => undefined); } setMenu(null); }}>しまう</button>
            </div>
          )}
          <div className="dm-grid dm-head" aria-hidden="true">
            {["月", "火", "水", "木", "金", "土", "日"].map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="dm-grid">
            {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
            {keys.map((key) => {
              const done = h.habit!.days.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className={`hb-day${done ? " done" : ""}${key === today ? " today" : ""}`}
                  disabled={key > today}
                  aria-pressed={done}
                  aria-label={`${Number(key.slice(8))}日${done ? "・やった" : ""}`}
                  onClick={() => toggle(h, key)}
                >
                  {Number(key.slice(8))}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
