import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Play } from "lucide-react";
import { byFlow, dayTasksFor, isFixed, planDay } from "./MobilePlanner";
import { shiftDateKey } from "./meals";
import { updateTask } from "./store";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import { localDateKey } from "./work-start";
import type { Task } from "./types";

/**
 * 時間の目盛りの表示（日 / 3日）: tasks sit on a time grid like a calendar app.
 * Free time between them is shown ("空き 1時間30分", tap to add there).
 * Long-press a block to move it (also to another day in 3日), drag its bottom
 * edge to change the length. Moving pins the task to that time.
 */
const FROM = 6 * 60;
const TO = 24 * 60;
const PX = 1.0; // px per minute
const SNAP = 15;
const HOLD_MS = 350;

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const durationText = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`);
const snap = (m: number, step = SNAP) => Math.round(m / step) * step;

interface Placed { task: Task; date: string; start: number; end: number; fixed: boolean }
interface Drag { id: string; kind: "move" | "resize"; startY: number; startX: number; orig: Placed; start: number; end: number; date: string; active: boolean }

export function TimeGrid({
  tasks,
  dates,
  onCreateAt,
  onOpen,
  onStart,
}: {
  tasks: Task[];
  dates: string[];
  onCreateAt: (date: string, startMinute: number) => void;
  onOpen: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  const today = localDateKey(new Date());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const holdTimer = useRef<number | null>(null);

  // 最初は「今」か朝8時あたりが見えるように。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const focus = dates.includes(today) ? now.getHours() * 60 + now.getMinutes() - 90 : 8 * 60;
    el.scrollTop = Math.max(0, (focus - FROM) * PX);
  }, [dates.join()]);

  const columns = dates.map((date) => {
    const dayTasks = dayTasksFor(tasks, date);
    const order = dayTasks.filter((t) => !isFixed(t)).sort(byFlow).map((t) => t.id);
    const plan = planDay(dayTasks, date, order, now);
    const placed: Placed[] = plan.rows
      .filter((r): r is Extract<typeof r, { kind: "task" }> => r.kind === "task")
      .map((r) => ({ task: r.task, date, start: r.entry.startMinute, end: r.entry.endMinute, fixed: isFixed(r.task) }));
    const gaps = plan.rows.filter((r): r is Extract<typeof r, { kind: "gap" }> => r.kind === "gap" && r.end - r.start >= 15);
    return { date, placed, gaps, busy: plan.busy, free: plan.free };
  });

  const colWidth = () => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return (grid.getBoundingClientRect().width - 40) / dates.length;
  };

  const begin = (event: ReactPointerEvent, p: Placed, kind: Drag["kind"]) => {
    const d: Drag = { id: p.task.id, kind, startY: event.clientY, startX: event.clientX, orig: p, start: p.start, end: p.end, date: p.date, active: kind === "resize" };
    dragRef.current = d;
    if (kind === "resize") {
      setDrag(d);
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      haptic("tick");
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    holdTimer.current = window.setTimeout(() => {
      if (!dragRef.current) return;
      dragRef.current = { ...dragRef.current, active: true };
      setDrag(dragRef.current);
      target.setPointerCapture?.(pointerId);
      haptic("tick");
    }, HOLD_MS);
  };

  const move = (event: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = event.clientY - d.startY;
    if (!d.active) {
      // 長押しの前に指が動いたらスクロール（ドラッグしない）。
      if (Math.abs(dy) > 8 || Math.abs(event.clientX - d.startX) > 8) cancelHold();
      return;
    }
    event.preventDefault();
    const minutes = dy / PX;
    let next: Drag;
    if (d.kind === "resize") {
      next = { ...d, end: Math.max(d.orig.start + 5, snap(d.orig.end + minutes, 5)) };
    } else {
      const length = d.orig.end - d.orig.start;
      const start = Math.min(TO - length, Math.max(FROM, snap(d.orig.start + minutes)));
      const shift = Math.round((event.clientX - d.startX) / colWidth());
      const index = Math.min(dates.length - 1, Math.max(0, dates.indexOf(d.orig.date) + shift));
      next = { ...d, start, end: start + length, date: dates[index] };
    }
    if (next.start !== d.start || next.end !== d.end || next.date !== d.date) haptic("tick");
    dragRef.current = next;
    setDrag(next);
  };

  const cancelHold = () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    if (dragRef.current && !dragRef.current.active) dragRef.current = null;
  };

  const end = async () => {
    cancelHold();
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || !d.active) return;
    if (d.kind === "resize") {
      const minutes = d.end - d.start;
      if (minutes !== d.orig.end - d.orig.start) {
        await updateTask(d.id, { estimateMin: minutes, durationMin: minutes }, `長さを${minutes}分に変更`);
        syncNow().catch(() => undefined);
      }
      return;
    }
    if (d.start === d.orig.start && d.date === d.orig.date) return;
    await updateTask(d.id, { scheduledDate: d.date, startMinute: d.start, isFixed: true, status: "planned" }, `${hm(d.start)}に移動`);
    syncNow().catch(() => undefined);
  };

  const hours = Array.from({ length: (TO - FROM) / 60 + 1 }, (_, i) => FROM + i * 60);
  const top = (m: number) => (m - FROM) * PX;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div className="tg">
      <div className="tg-head" style={{ gridTemplateColumns: `40px repeat(${dates.length}, minmax(0, 1fr))` }}>
        <span />
        {columns.map((c) => {
          const d = new Date(`${c.date}T12:00:00`);
          return (
            <div key={c.date} className={`tg-day${c.date === today ? " today" : ""}`}>
              <strong>{d.getDate()}<small>{d.toLocaleDateString("ja-JP", { weekday: "short" })}</small></strong>
              <small>空き {durationText(c.free)}</small>
            </div>
          );
        })}
      </div>
      <div className="tg-scroll" ref={scrollRef}>
        <div
          className={`tg-grid${drag?.active ? " dragging" : ""}`}
          ref={gridRef}
          style={{ height: (TO - FROM) * PX, gridTemplateColumns: `40px repeat(${dates.length}, minmax(0, 1fr))` }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <div className="tg-hours">
            {hours.map((h) => <span key={h} style={{ top: top(h) }}>{hm(h)}</span>)}
          </div>
          {columns.map((c) => (
            <div key={c.date} className="tg-col">
              {hours.map((h) => <i key={h} className="tg-line" style={{ top: top(h) }} />)}
              {c.gaps.map((g) => (
                <button key={`g${g.start}`} type="button" className="tg-gap" style={{ top: top(g.start) + 1, height: Math.max(16, (g.end - g.start) * PX - 2) }} onClick={() => onCreateAt(c.date, Math.ceil(g.start / 5) * 5)}>
                  空き {durationText(g.end - g.start)}
                </button>
              ))}
              {c.placed.map((p) => {
                const live = drag?.active && drag.id === p.task.id ? drag : null;
                if (live && live.date !== c.date) return null;
                const start = live ? live.start : p.start;
                const endMin = live ? live.end : p.end;
                return (
                  <div
                    key={p.task.id}
                    className={`tg-block${p.fixed ? " fixed" : ""}${live ? " lifted" : ""}${p.task.status === "active" ? " running" : ""}`}
                    style={{ top: top(start), height: Math.max(20, (endMin - start) * PX - 2) }}
                    onPointerDown={(e) => begin(e, p, "move")}
                  >
                    <button type="button" className="tg-title" onClick={() => { if (!dragRef.current?.active) onOpen(p.task); }}>
                      <strong>{p.task.title}</strong>
                      <small>{hm(start)}〜{hm(endMin)}</small>
                    </button>
                    <button type="button" className="tg-play" aria-label={`${p.task.title}を開始`} onClick={() => onStart(p.task)}>
                      <Play size={12} />
                    </button>
                    <span className="tg-resize" aria-label="下を引っぱって長さを変える" onPointerDown={(e) => { e.stopPropagation(); begin(e, p, "resize"); }} />
                  </div>
                );
              })}
              {/* 別の日に持っていく途中のブロック */}
              {drag?.active && drag.kind === "move" && drag.date === c.date && drag.orig.date !== c.date && (
                <div className="tg-block lifted" style={{ top: top(drag.start), height: Math.max(20, (drag.end - drag.start) * PX - 2) }}>
                  <span className="tg-title"><strong>{drag.orig.task.title}</strong><small>{hm(drag.start)}</small></span>
                </div>
              )}
              {c.date === today && nowMin >= FROM && nowMin <= TO && <i className="tg-now" style={{ top: top(nowMin) }} />}
            </div>
          ))}
        </div>
      </div>
      <p className="tg-hint">長押しで移動・下の端を引っぱって長さを変える・空きを押すと追加</p>
    </div>
  );
}

export function threeDays(date: string): string[] {
  return [date, shiftDateKey(date, 1), shiftDateKey(date, 2)];
}
