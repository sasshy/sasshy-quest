import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, MoreHorizontal, Plus } from "lucide-react";
import { db } from "./db";
import { archiveHabit, countIn, createHabit, habits, renameHabit, setHabitDay } from "./habits";
import { getRoutines, saveRoutines } from "./routines";
import { localDateKey } from "./meals";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import type { Memo } from "./types";

/** 記録 › 習慣: tap ✓ for today, a week table of every habit, one habit's month on demand. */
export function HabitsPanel() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const list = habits(memos);
  const today = localDateKey(Date.now());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [draft, setDraft] = useState("");
  const routines = useLiveQuery(async () => { await db.settings.get("routines"); return getRoutines(); }, [], []) || [];
  const [stepOf, setStepOf] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  // 週の表（0 = 今週, -1 = 先週…）と、名前を押して開いた習慣。
  const [week, setWeek] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const openHabit = list.find((h) => h.id === open) || null;
  const weekKeys = (() => {
    const [ty, tm, td] = today.split("-").map(Number);
    const base = new Date(ty, tm - 1, td);
    const monday = new Date(ty, tm - 1, td - ((base.getDay() + 6) % 7) + week * 7);
    return Array.from({ length: 7 }, (_, i) => localDateKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i).getTime()));
  })();
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
        {list.length === 0 && <p className="hb-empty">まだ習慣がありません。下から足してください。</p>}
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
          // ルーティンを選んだら、そのルーティンの最後のステップにも入れる（終えると習慣に✓）。
          const routine = routines.find((r) => r.id === stepOf);
          await createHabit(typed, null, routine?.name || null);
          if (routine && !routine.steps.some((s) => s.title === typed)) {
            await saveRoutines(routines.map((r) => (r.id === routine.id ? { ...r, steps: [...r.steps, { title: typed, minutes: 3 }] } : r)));
          }
          setDraft("");
          setStepOf("");
          syncNow().catch(() => undefined);
        }}>
          <input name="habit" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="習慣を足す（例：0時までに寝る・筋トレ1分）" />
          <button className="button primary" type="submit" aria-label="習慣を足す"><Plus size={18} /></button>
          {draft.trim() && routines.length > 0 && (
            <label className="hb-step">
              <span>ルーティンの最後にも入れる</span>
              <select value={stepOf} onChange={(e) => setStepOf(e.currentTarget.value)}>
                <option value="">入れない</option>
                {routines.map((r) => <option key={r.id} value={r.id}>{r.name}の最後</option>)}
              </select>
            </label>
          )}
        </form>
      </section>

      {list.length > 0 && (
        <section className="hb-week">
          <div className="dm-nav hb-nav">
            <button type="button" aria-label="前の週" onClick={() => setWeek(week - 1)}>‹</button>
            <strong>{week === 0 ? "今週" : `${weekKeys[0].slice(5).replace("-", "/")}〜${weekKeys[6].slice(5).replace("-", "/")}`}</strong>
            <button type="button" aria-label="次の週" disabled={week >= 0} onClick={() => setWeek(week + 1)}>›</button>
          </div>
          <div className="hb-matrix" role="grid">
            <div className="hb-row hb-row-head" role="row">
              {weekKeys.map((key, i) => (
                <span key={key} className={`${key === today ? "today" : ""}${i >= 5 ? " weekend" : ""}`}>
                  {"月火水木金土日"[i]}<small>{Number(key.slice(8))}</small>
                </span>
              ))}
            </div>
            {list.map((h) => {
              const n = weekKeys.filter((k) => h.habit!.days.includes(k)).length;
              return (
                <div key={h.id} className="hb-item">
                  <button type="button" className={`hb-row-name${open === h.id ? " open" : ""}`} onClick={() => { setOpen(open === h.id ? null : h.id); setMenu(null); }}>
                    <span>{h.habit!.name}</span>
                    <small>今週{n}回 ›</small>
                  </button>
                  <div className="hb-row" role="row">
                  {weekKeys.map((key) => {
                    const done = h.habit!.days.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`hb-cell${done ? " done" : ""}${key === today ? " today" : ""}`}
                        disabled={key > today}
                        aria-pressed={done}
                        aria-label={`${h.habit!.name} ${Number(key.slice(5, 7))}/${Number(key.slice(8))}${done ? "・やった" : ""}`}
                        onClick={() => toggle(h, key)}
                      >
                        {done && <Check size={14} strokeWidth={3} />}
                      </button>
                    );
                  })}
                  </div>
                </div>
              );
            })}
          </div>
          <small className="hb-hint">名前を押すと、その習慣の1か月が見られます</small>
        </section>
      )}

      {openHabit && (
        <section className="hb-card">
          <header>
            <strong>{openHabit.habit!.name}</strong>
            <span className="hb-count">{countIn(openHabit, month)}<small>回</small></span>
            <button type="button" className="hb-more" aria-label={`${openHabit.habit!.name}の設定`} onClick={() => setMenu(menu ? null : openHabit.id)}><MoreHorizontal size={18} /></button>
          </header>
          {menu === openHabit.id && (
            <div className="hb-menu">
              <button type="button" onClick={async () => { const name = window.prompt("新しい名前", openHabit.habit!.name); if (name) { await renameHabit(openHabit, name); syncNow().catch(() => undefined); } setMenu(null); }}>名前を変える</button>
              <button type="button" className="danger" onClick={async () => { if (window.confirm(`「${openHabit.habit!.name}」をしまいますか？（記録は残ります）`)) { await archiveHabit(openHabit); syncNow().catch(() => undefined); setOpen(null); } setMenu(null); }}>しまう</button>
            </div>
          )}
          <div className="dm-nav hb-nav">
            <button type="button" aria-label="前の月" onClick={() => shift(-1)}>‹</button>
            <strong>{y}年{m}月</strong>
            <button type="button" aria-label="次の月" disabled={month >= today.slice(0, 7)} onClick={() => shift(1)}>›</button>
          </div>
          <div className="dm-grid dm-head" aria-hidden="true">
            {["月", "火", "水", "木", "金", "土", "日"].map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="dm-grid">
            {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
            {keys.map((key) => {
              const done = openHabit.habit!.days.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className={`hb-day${done ? " done" : ""}${key === today ? " today" : ""}`}
                  disabled={key > today}
                  aria-pressed={done}
                  aria-label={`${Number(key.slice(8))}日${done ? "・やった" : ""}`}
                  onClick={() => toggle(openHabit, key)}
                >
                  {Number(key.slice(8))}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
