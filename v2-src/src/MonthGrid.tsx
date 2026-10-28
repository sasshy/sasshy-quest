import { useState } from "react";
import { Check, Play, Plus } from "lucide-react";
import { byFlow, isFixed } from "./MobilePlanner";
import { localDateKey } from "./work-start";
import { updateTask } from "./store";
import { syncNow } from "./sync";
import { workDayKey } from "./dayline";
import { moveGoogleEvent } from "./google-calendar";
import type { FocusSession, Task, GoogleCalendarEvent } from "./types";

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
  events = [],
  sessions = [],
}: {
  tasks: Task[];
  /** 実際にかかった時間を出すため。 */
  sessions?: FocusSession[];
  /** Googleカレンダーの予定（月の中は点、下の一覧には時刻つきで出す）。 */
  events?: GoogleCalendarEvent[];
  date: string;
  onSelect: (date: string) => void;
  onCreateAt: (date: string, startMinute: number) => void;
  onOpen: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  // 朝4時までは前の日（今夜のルーティンを「やらなかった」にしない）。
  const today = workDayKey(new Date());
  const [y, m] = date.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  const keys = Array.from({ length: days }, (_, i) => `${y}-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
  const [selected, setSelected] = useState(date);
  // 移すモード：一覧の「移す」を押してから、カレンダーの日を押すとその日に移る（時刻はそのまま）。
  const [moving, setMoving] = useState<{ task?: Task; event?: GoogleCalendarEvent; title: string } | null>(null);
  const moveTo = async (key: string) => {
    const m = moving;
    setMoving(null);
    if (!m) return;
    try {
      if (m.task) {
        await updateTask(m.task.id, { scheduledDate: key, status: m.task.status === "inbox" ? "planned" : m.task.status }, `${Number(key.slice(5, 7))}/${Number(key.slice(8))}に移動`);
        syncNow().catch(() => undefined);
      } else if (m.event) {
        const s = m.event.allDay ? new Date(`${key}T00:00:00`) : new Date(m.event.start);
        const shift = m.event.allDay ? 0 : Date.parse(`${key}T00:00:00`) - Date.parse(`${localDateKey(new Date(m.event.start))}T00:00:00`);
        const start = m.event.allDay ? s : new Date(s.getTime() + shift);
        const len = m.event.end ? Date.parse(m.event.end) - Date.parse(m.event.start) : 30 * 60_000;
        const end = m.event.allDay ? new Date(new Date(`${key}T00:00:00`).getTime() + Math.max(1, Math.round(len / 86_400_000)) * 86_400_000) : new Date(start.getTime() + len);
        await moveGoogleEvent(m.event, start, end);
      }
      window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: `「${m.title}」を${Number(key.slice(5, 7))}/${Number(key.slice(8))}に移しました` }));
      setSelected(key);
    } catch (error) {
      window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: error instanceof Error ? error.message : String(error) }));
    }
  };
  const live = tasks.filter((t) => !t.deletedAt && !t.log);
  const onDay = (key: string) => live.filter((t) => t.scheduledDate === key);
  const dueOn = (key: string) => live.filter((t) => t.dueDate === key && t.status !== "done");
  // 予定（まだのもの）と、やったこと（終わった時刻の日）を分ける。手順に分けた元・飛ばした手順（archived）は出さない。
  const selectedTasks = onDay(selected)
    .filter((t) => t.status !== "done" && t.status !== "archived")
    .sort((a, b) => (a.startMinute ?? 9999) - (b.startMinute ?? 9999) || byFlow(a, b));
  const doneDay = (t: Task) => (t.completedAt ? workDayKey(t.completedAt) : t.scheduledDate);
  const doneTasks = live
    .filter((t) => t.status === "done" && doneDay(t) === selected)
    .sort((a, b) => Date.parse(a.completedAt || "") - Date.parse(b.completedAt || ""));
  const spentMin = (t: Task) => Math.round(sessions
    .filter((x) => x.taskId === t.id && !x.deletedAt && x.status === "completed" && x.endedAt)
    .reduce((sum, x) => sum + Math.max(0, Date.parse(x.endedAt!) - Date.parse(x.startedAt) - (x.pausedTotalSec || 0) * 1000), 0) / 60_000);
  const clock = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return hm(d.getHours() * 60 + d.getMinutes());
  };
  const sel = new Date(`${selected}T12:00:00`);
  const gOn = (key: string) => events.filter((e) => (e.allDay ? e.start <= key && (e.end ? e.end > key : e.start === key) : localDateKey(new Date(e.start)) === key));
  const gTime = (e: GoogleCalendarEvent) => (e.allDay ? "終日" : hm(new Date(e.start).getHours() * 60 + new Date(e.start).getMinutes()));

  return (
    <div className="mg">
      <div className="mg-head" aria-hidden="true">
        {["月", "火", "水", "木", "金", "土", "日"].map((d, i) => <span key={d} className={i === 5 ? "sat" : i === 6 ? "sun" : ""}>{d}</span>)}
      </div>
      {moving && (
        <div className="mg-moving" role="status">
          <span>「{moving.title}」を移す日を押してください</span>
          <button type="button" onClick={() => setMoving(null)}>やめる</button>
        </div>
      )}
      <div className={`mg-grid${moving ? " moving" : ""}`}>
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
              onClick={() => { if (moving) { moveTo(key); return; } setSelected(key); onSelect(key); }}
              aria-label={`${i + 1}日 ${open.length}件${dueOn(key).length ? "・締切あり" : ""}`}
            >
              <strong>{i + 1}</strong>
              <span className="mg-bars">
                {Array.from({ length: bars }, (_, b) => <i key={b} className={open.some(isFixed) && b === 0 ? "fixed" : ""} />)}
              </span>
              {list.length > 0 && <small>{open.length ? open.length : "✓"}</small>}
              {dueOn(key).length > 0 && <b className="mg-due" />}
              {gOn(key).length > 0 && <em className="mg-g" aria-hidden="true">{gOn(key).length > 1 ? gOn(key).length : ""}</em>}
            </button>
          );
        })}
      </div>
      <div className="mg-legend"><span><i /> 1本＝約1時間の予定</span><span><b className="mg-due" /> 締め切り</span><span><em className="mg-g" /> Googleの予定</span></div>

      <section className="mg-list">
        <header>
          <strong>{sel.getMonth() + 1}/{sel.getDate()}（{sel.toLocaleDateString("ja-JP", { weekday: "short" })}）</strong>
          <button type="button" onClick={() => onCreateAt(selected, 9 * 60)}><Plus size={15} /> この日に追加</button>
        </header>
        {gOn(selected).map((e) => (
          <div key={`g-${e.id}`} className="mg-row gcal">
            <span className="mg-time">{gTime(e)}</span>
            <span className="mg-title"><strong>{e.title}</strong><small>Googleカレンダー{e.calendarName ? `・${e.calendarName}` : ""}</small></span>
            {!e.recurring && e.editable !== false && <button type="button" className="mg-move" onClick={() => { setMoving({ event: e, title: e.title }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>移す</button>}
          </div>
        ))}
        {selectedTasks.length === 0 && doneTasks.length === 0 && gOn(selected).length === 0 && <p>予定はありません</p>}
        {selectedTasks.length > 0 && <h4 className="mg-sub">{selected < today ? `やらなかった・まだ（${selectedTasks.length}）` : `予定（${selectedTasks.length}）`}</h4>}
        {selectedTasks.map((t) => (
          <div key={t.id} className={`mg-row${selected < today ? " missed" : ""}`}>
            <span className="mg-time">{isFixed(t) && t.startMinute !== null ? hm(t.startMinute) : "—"}</span>
            <button type="button" className="mg-title" onClick={() => onOpen(t)}>
              <strong>{t.title}</strong>
              <small>{t.estimateMin}分の予定{t.dueDate === selected ? "・締切" : ""}</small>
            </button>
            <button type="button" className="mg-move" onClick={() => { setMoving({ task: t, title: t.title }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>移す</button>
            <button type="button" className="mg-play" aria-label={`${t.title}を開始`} onClick={() => onStart(t)}><Play size={13} /></button>
          </div>
        ))}
        {doneTasks.length > 0 && <h4 className="mg-sub done">やったこと（{doneTasks.length}）</h4>}
        {doneTasks.map((t) => {
          const spent = spentMin(t);
          return (
            <div key={t.id} className="mg-row done">
              <span className="mg-time"><Check size={12} /> {clock(t.completedAt)}</span>
              <button type="button" className="mg-title" onClick={() => onOpen(t)}>
                <strong>{t.title}</strong>
                <small>{spent > 0 ? `実際${spent}分` : "完了の印だけ"}{t.routine ? `・${t.routine.name}` : ""}</small>
              </button>
            </div>
          );
        })}
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
