import { useState } from "react";
import { Play, Plus } from "lucide-react";
import { byFlow, isFixed } from "./MobilePlanner";
import { localDateKey } from "./work-start";
import type { Task } from "./types";

/**
 * スマホの月表示: each day only shows how full it is (thin bars) and
 * deadlines (orange dot) — no squeezed text. Tap a day to see its list below.
 */
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

export function MonthGrid({
  tasks,
  date,
  onSelect,
  onCreateAt,
  onOpen,
  onStart,
}: {
  tasks: Task[];
  date: string;
  onSelect: (date: string) => void;
  onCreateAt: (date: string, startMinute: number) => void;
  onOpen: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  const today = localDateKey(new Date());
  const [y, m] = date.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  const keys = Array.from({ length: days }, (_, i) => `${y}-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
  const [selected, setSelected] = useState(date);
  const live = tasks.filter((t) => !t.deletedAt && !t.log);
  const onDay = (key: string) => live.filter((t) => t.scheduledDate === key);
  const dueOn = (key: string) => live.filter((t) => t.dueDate === key && t.status !== "done");
  const selectedTasks = onDay(selected).sort((a, b) => (a.startMinute ?? 9999) - (b.startMinute ?? 9999) || byFlow(a, b));
  const sel = new Date(`${selected}T12:00:00`);

  return (
    <div className="mg">
      <div className="mg-head" aria-hidden="true">
        {["月", "火", "水", "木", "金", "土", "日"].map((d, i) => <span key={d} className={i === 5 ? "sat" : i === 6 ? "sun" : ""}>{d}</span>)}
      </div>
      <div className="mg-grid">
        {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
        {keys.map((key, i) => {
          const list = onDay(key);
          const open = list.filter((t) => t.status !== "done");
          const minutes = open.reduce((sum, t) => sum + t.estimateMin, 0);
          const bars = Math.min(4, Math.ceil(minutes / 60));
          const dow = (lead + i) % 7;
          return (
            <button
              key={key}
              type="button"
              className={`mg-day${key === today ? " today" : ""}${key === selected ? " selected" : ""}${key < today ? " past" : ""}${dow === 5 ? " sat" : dow === 6 ? " sun" : ""}`}
              onClick={() => { setSelected(key); onSelect(key); }}
              aria-label={`${i + 1}日 ${open.length}件${dueOn(key).length ? "・締切あり" : ""}`}
            >
              <strong>{i + 1}</strong>
              <span className="mg-bars">
                {Array.from({ length: bars }, (_, b) => <i key={b} className={open.some(isFixed) && b === 0 ? "fixed" : ""} />)}
              </span>
              {list.length > 0 && <small>{open.length ? open.length : "✓"}</small>}
              {dueOn(key).length > 0 && <b className="mg-due" />}
            </button>
          );
        })}
      </div>
      <div className="mg-legend"><span><i /> 1本＝約1時間の予定</span><span><b className="mg-due" /> 締め切り</span></div>

      <section className="mg-list">
        <header>
          <strong>{sel.getMonth() + 1}/{sel.getDate()}（{sel.toLocaleDateString("ja-JP", { weekday: "short" })}）</strong>
          <button type="button" onClick={() => onCreateAt(selected, 9 * 60)}><Plus size={15} /> この日に追加</button>
        </header>
        {selectedTasks.length === 0 && <p>予定はありません</p>}
        {selectedTasks.map((t) => (
          <div key={t.id} className={`mg-row${t.status === "done" ? " done" : ""}`}>
            <span className="mg-time">{isFixed(t) && t.startMinute !== null ? hm(t.startMinute) : "—"}</span>
            <button type="button" className="mg-title" onClick={() => onOpen(t)}>
              <strong>{t.title}</strong>
              <small>{t.estimateMin}分{t.dueDate === selected ? "・締切" : ""}</small>
            </button>
            {t.status !== "done" && <button type="button" className="mg-play" aria-label={`${t.title}を開始`} onClick={() => onStart(t)}><Play size={13} /></button>}
          </div>
        ))}
        {dueOn(selected).filter((t) => t.scheduledDate !== selected).map((t) => (
          <div key={`due-${t.id}`} className="mg-row due">
            <span className="mg-time">締切</span>
            <button type="button" className="mg-title" onClick={() => onOpen(t)}><strong>{t.title}</strong><small>この日が締め切り</small></button>
          </div>
        ))}
      </section>
    </div>
  );
}
