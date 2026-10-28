import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, MoreHorizontal, Plus } from "lucide-react";
import { db } from "./db";
import { archiveHabit, archivedHabits, countIn, createHabit, deleteHabit, habits, renameHabit, restoreHabit, setHabitDay } from "./habits";
import { getRoutines, saveRoutines } from "./routines";
import { localDateKey } from "./meals";
import { syncNow } from "./sync";
import { isRuleHabit, ruleDay, yenText } from "./habit-rules";
import { haptic } from "./feedback";
import type { Memo } from "./types";

/** 記録 › 習慣: tap ✓ for today, a week table of every habit, one habit's month on demand. */
export function HabitsPanel() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const list = habits(memos);
  const shelved = archivedHabits(memos);
  const today = localDateKey(Date.now());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [draft, setDraft] = useState("");
  const routines = useLiveQuery(async () => { await db.settings.get("routines"); return getRoutines(); }, [], []) || [];
  const [stepOf, setStepOf] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
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
  // 自動の習慣（お昼と間食◯円以内など）は記録から決まる。手の✓は使わない。
  const stateOf = (h: Memo, key: string) => {
    if (!isRuleHabit(h)) {
      const done = h.habit!.days.includes(key);
      return { done, over: false, skip: false, pending: false, spent: 0 };
    }
    const r = ruleDay(h, memos, key, today);
    return { done: r.state === "done" || r.state === "pending", over: r.state === "over", skip: r.state === "skip", pending: r.state === "pending", spent: r.spent };
  };
  const countOf = (h: Memo, prefix: string) => {
    if (!isRuleHabit(h)) return countIn(h, prefix);
    const [py, pm] = prefix.split("-").map(Number);
    const n = new Date(py, pm, 0).getDate();
    let c = 0;
    for (let d = 1; d <= n; d += 1) {
      const key = `${prefix}-${String(d).padStart(2, "0")}`;
      if (key > today) break;
      if (stateOf(h, key).done) c += 1;
    }
    return c;
  };
  const cellClass = (st: ReturnType<typeof stateOf>) => `${st.done ? " done" : ""}${st.over ? " over" : ""}${st.skip ? " skip" : ""}${st.pending ? " pending" : ""}`;
  const toggle = async (memo: Memo, date: string) => {
    if (isRuleHabit(memo)) return;
    const done = !memo.habit!.days.includes(date);
    if (done) haptic("success");
    await setHabitDay(memo, date, done);
    syncNow().catch(() => undefined);
  };

  return (
    <div className="habits">
      <section className="hb-today">
        <header className="hb-head">
          <h2>今日の習慣</h2>
          {(list.length > 0 || shelved.length > 0) && (
            <button type="button" className={`hb-edit-toggle${editMode ? " on" : ""}`} onClick={() => { setEditMode(!editMode); setArmed(null); }}>
              {editMode ? "完了" : "編集"}
            </button>
          )}
          <small>{editMode ? "名前を直す・しまう（記録は残る）・消す" : "押すと✓。続かなくても大丈夫、数えるのは「今月◯回」だけ"}</small>
        </header>
        {list.length === 0 && <p className="hb-empty">まだ習慣がありません。下から足してください。</p>}
        {editMode && (
          <div className="hb-edit-list">
            {list.map((h) => (
              <div key={h.id} className="hb-edit-row">
                <input
                  defaultValue={h.habit!.name}
                  aria-label={`${h.habit!.name}の名前`}
                  maxLength={40}
                  onBlur={async (e) => {
                    const name = e.currentTarget.value.trim();
                    if (name && name !== h.habit!.name) { await renameHabit(h, name); syncNow().catch(() => undefined); }
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
                <button type="button" onClick={async () => { await archiveHabit(h); syncNow().catch(() => undefined); }}>しまう</button>
                {/* 確認ダイアログに頼らず、2回押しで消す。 */}
                <button type="button" className={`danger${armed === h.id ? " armed" : ""}`} onClick={async () => {
                  if (armed !== h.id) { setArmed(h.id); window.setTimeout(() => setArmed((v) => (v === h.id ? null : v)), 3000); return; }
                  setArmed(null);
                  await deleteHabit(h);
                  syncNow().catch(() => undefined);
                }}>{armed === h.id ? "もう一度" : "消す"}</button>
              </div>
            ))}
            {shelved.length > 0 && (
              <>
                <span className="hb-shelf-title">しまった習慣（{shelved.length}）</span>
                {shelved.map((h) => (
                  <div key={h.id} className="hb-edit-row shelved">
                    <span className="hb-shelf-name">{h.habit!.name}<small>{h.habit!.days.length}回の記録</small></span>
                    <button type="button" onClick={async () => { await restoreHabit(h); syncNow().catch(() => undefined); }}>戻す</button>
                    <button type="button" className={`danger${armed === h.id ? " armed" : ""}`} onClick={async () => {
                      if (armed !== h.id) { setArmed(h.id); window.setTimeout(() => setArmed((v) => (v === h.id ? null : v)), 3000); return; }
                      setArmed(null);
                      await deleteHabit(h);
                      syncNow().catch(() => undefined);
                    }}>{armed === h.id ? "もう一度" : "消す"}</button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {!editMode && (
        <div className="hb-checks">
          {list.map((h) => {
            const st = stateOf(h, today);
            const done = st.done;
            const rule = h.habit!.rule;
            return (
              <button key={h.id} type="button" className={`hb-check${cellClass(st)}${rule ? " auto" : ""}`} aria-pressed={done} onClick={() => toggle(h, today)}>
                <span className="hb-box">{done && <Check size={18} strokeWidth={3} />}{st.over && "×"}{st.skip && "−"}</span>
                <span className="hb-name">{h.habit!.name}{rule && <em className="hb-auto">自動</em>}</span>
                <small>{rule ? (st.skip ? "今日は会食" : `今日 ${yenText(st.spent)} / ${yenText(rule.limit)}`) : `今月${countOf(h, today.slice(0, 7))}回`}</small>
              </button>
            );
          })}
        </div>
        )}
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
              const n = weekKeys.filter((k) => stateOf(h, k).done).length;
              return (
                <div key={h.id} className="hb-item">
                  <button type="button" className={`hb-row-name${open === h.id ? " open" : ""}`} onClick={() => { setOpen(open === h.id ? null : h.id); setMenu(null); }}>
                    <span>{h.habit!.name}</span>
                    <small>今週{n}回 ›</small>
                  </button>
                  <div className="hb-row" role="row">
                  {weekKeys.map((key) => {
                    const st = stateOf(h, key);
                    const done = st.done;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`hb-cell${cellClass(st)}${key === today ? " today" : ""}`}
                        disabled={key > today || isRuleHabit(h)}
                        aria-pressed={done}
                        title={isRuleHabit(h) && key <= today ? (st.skip ? "会食の日" : yenText(st.spent)) : undefined}
                        aria-label={`${h.habit!.name} ${Number(key.slice(5, 7))}/${Number(key.slice(8))}${done ? "・できた" : st.over ? "・超えた" : st.skip ? "・数えない日" : ""}`}
                        onClick={() => toggle(h, key)}
                      >
                        {done && <Check size={14} strokeWidth={3} />}
                        {st.over && "×"}
                        {st.skip && "−"}
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
            <span className="hb-count">{countOf(openHabit, month)}<small>回</small></span>
            <button type="button" className="hb-more" aria-label={`${openHabit.habit!.name}の設定`} onClick={() => setMenu(menu ? null : openHabit.id)}><MoreHorizontal size={18} /></button>
          </header>
          {menu === openHabit.id && (
            <div className="hb-menu">
              <button type="button" onClick={() => { setEditMode(true); setMenu(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}>名前を変える・消す</button>
              <button type="button" className="danger" onClick={async () => { await archiveHabit(openHabit); syncNow().catch(() => undefined); setOpen(null); setMenu(null); }}>しまう</button>
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
              const st = stateOf(openHabit, key);
              const done = st.done;
              return (
                <button
                  key={key}
                  type="button"
                  className={`hb-day${cellClass(st)}${key === today ? " today" : ""}`}
                  disabled={key > today || isRuleHabit(openHabit)}
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
