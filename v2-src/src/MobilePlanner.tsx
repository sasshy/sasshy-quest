import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, Play, Plus } from "lucide-react";
import { buildDayRunway, type RunwayEntry } from "./day-runway";
import { shiftDateKey } from "./meals";
import { setTasksFlowOrder } from "./store";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import type { Task } from "./types";
import { localDateKey } from "./work-start";

/**
 * Phone calendar (日 / 週). Built for fingers: the day is a time-ordered list
 * with the free gaps shown ("空き 45分", tap to add there); flexible tasks are
 * reordered by dragging the handle and their times follow; tapping a task opens
 * the move sheet (day / time).
 */
const DAY_START = 8 * 60;
const DAY_END = 22 * 60;

const hm = (minute: number) => {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
const durationText = (min: number) =>
  min >= 60 ? `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`;
const dateLabel = (key: string) =>
  new Date(`${key}T12:00:00`).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });

function byFlow(a: Task, b: Task): number {
  if (a.flowOrder !== undefined || b.flowOrder !== undefined) {
    if (a.flowOrder === undefined) return 1;
    if (b.flowOrder === undefined) return -1;
    if (a.flowOrder !== b.flowOrder) return a.flowOrder - b.flowOrder;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

const isFixed = (task: Task) => task.startMinute !== null && task.isFixed !== false;

export function dayTasksFor(tasks: Task[], date: string): Task[] {
  return tasks.filter((t) => !t.deletedAt && t.scheduledDate === date && t.status !== "done");
}

/** Plan the day: fixed tasks stay, flexible ones fill from now (today) or 8:00. */
export function planDay(tasks: Task[], date: string, flexibleOrder: string[], now = new Date()) {
  const today = localDateKey(now);
  const startMinute = date === today ? Math.max(DAY_START, now.getHours() * 60 + now.getMinutes()) : DAY_START;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const flexible = flexibleOrder.map((id) => byId.get(id)).filter((t): t is Task => Boolean(t));
  const fixed = tasks.filter(isFixed);
  const plan = buildDayRunway(
    [
      ...flexible.map((t) => ({ id: t.id, title: t.title, durationMin: t.estimateMin, fixed: false, startMinute: null, kind: "task" as const })),
      ...fixed.map((t) => ({ id: t.id, title: t.title, durationMin: t.estimateMin, fixed: true, startMinute: t.startMinute, kind: "task" as const })),
    ],
    { nowMinute: startMinute, dayEndMinute: DAY_END, preparationMin: 5 },
  );
  const entries = [...plan.entries].sort((a, b) => a.startMinute - b.startMinute);
  type Row = { kind: "gap"; start: number; end: number } | { kind: "task"; entry: RunwayEntry; task: Task };
  const rows: Row[] = [];
  let cursor = Math.ceil(startMinute / 5) * 5;
  for (const entry of entries) {
    if (entry.startMinute - cursor >= 10) rows.push({ kind: "gap", start: cursor, end: entry.startMinute });
    const task = byId.get(entry.id);
    if (task) rows.push({ kind: "task", entry, task });
    cursor = Math.max(cursor, entry.endMinute);
  }
  if (DAY_END - cursor >= 10) rows.push({ kind: "gap", start: cursor, end: DAY_END });
  const busy = entries.reduce((sum, e) => sum + (e.endMinute - e.startMinute), 0);
  const free = Math.max(0, DAY_END - startMinute - busy);
  return { rows, busy, free, startMinute };
}

export function MobilePlanner({
  tasks,
  mode,
  date,
  onDate,
  onShowDay,
  onMove,
  onCreateAt,
  onStart,
}: {
  tasks: Task[];
  mode: "day" | "week";
  date: string;
  onDate: (date: string) => void;
  onShowDay: (date: string) => void;
  onMove: (task: Task) => void;
  onCreateAt: (date: string, startMinute: number) => void;
  onStart: (task: Task) => void;
}) {
  const today = localDateKey(new Date());
  const monday = useMemo(() => {
    const d = new Date(`${date}T12:00:00`);
    return shiftDateKey(date, -((d.getDay() + 6) % 7));
  }, [date]);
  const week = Array.from({ length: 7 }, (_, i) => shiftDateKey(monday, i));

  const strip = (
    <div className="mp-week-strip" role="tablist" aria-label="週">
      {week.map((key) => {
        const count = dayTasksFor(tasks, key).length;
        const d = new Date(`${key}T12:00:00`);
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === date}
            className={`${key === date ? "active" : ""}${key === today ? " today" : ""}`}
            onClick={() => onShowDay(key)}
          >
            <small>{d.toLocaleDateString("ja-JP", { weekday: "short" })}</small>
            <strong>{d.getDate()}</strong>
            <i>{count ? "•".repeat(Math.min(3, count)) : ""}</i>
          </button>
        );
      })}
    </div>
  );

  if (mode === "week") {
    return (
      <div className="mp">
        <div className="mp-week">
          {week.map((key) => {
            const dayTasks = dayTasksFor(tasks, key);
            const { busy, free } = planDay(dayTasks, key, dayTasks.filter((t) => !isFixed(t)).sort(byFlow).map((t) => t.id));
            const total = busy + free || 1;
            return (
              <button key={key} type="button" className={`mp-week-day${key === today ? " today" : ""}`} onClick={() => onShowDay(key)}>
                <div className="mp-week-head">
                  <strong>{dateLabel(key)}</strong>
                  <span>{dayTasks.length ? `${dayTasks.length}件・予定${durationText(busy)}` : "予定なし"}</span>
                </div>
                <div className="mp-load" aria-label={`予定${durationText(busy)}、空き${durationText(free)}`}>
                  <i style={{ width: `${(busy / total) * 100}%` }} />
                </div>
                {key >= today && <small className="mp-free">空き {durationText(free)}</small>}
                {dayTasks.length > 0 && (
                  <ul>
                    {dayTasks.sort((a, b) => (a.startMinute ?? 9999) - (b.startMinute ?? 9999) || byFlow(a, b)).slice(0, 3).map((t) => (
                      <li key={t.id}>
                        {t.startMinute !== null && isFixed(t) ? <b>{hm(t.startMinute)}</b> : null}
                        {t.title}
                      </li>
                    ))}
                    {dayTasks.length > 3 && <li className="more">ほか{dayTasks.length - 3}件</li>}
                  </ul>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mp">
      {strip}
      <DayList tasks={tasks} date={date} onMove={onMove} onCreateAt={onCreateAt} onStart={onStart} />
    </div>
  );
}

function DayList({
  tasks,
  date,
  onMove,
  onCreateAt,
  onStart,
}: {
  tasks: Task[];
  date: string;
  onMove: (task: Task) => void;
  onCreateAt: (date: string, startMinute: number) => void;
  onStart: (task: Task) => void;
}) {
  const dayTasks = useMemo(() => dayTasksFor(tasks, date), [tasks, date]);
  const savedOrder = useMemo(() => dayTasks.filter((t) => !isFixed(t)).sort(byFlow).map((t) => t.id), [dayTasks]);
  const [order, setOrder] = useState(savedOrder);
  const orderRef = useRef(order);
  const dragging = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  useEffect(() => {
    if (dragging.current) return;
    setOrder(savedOrder);
    orderRef.current = savedOrder;
  }, [savedOrder]);
  const { rows, busy, free } = planDay(dayTasks, date, order);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const id = dragging.current;
    if (!id) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-flex-id]"));
    const target = items.find((el) => {
      const rect = el.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    const targetId = target?.dataset.flexId;
    if (targetId === id) return;
    const next = orderRef.current.filter((x) => x !== id);
    const index = targetId ? next.indexOf(targetId) : -1;
    next.splice(index < 0 ? next.length : index, 0, id);
    if (next.join() === orderRef.current.join()) return;
    orderRef.current = next;
    setOrder(next);
    haptic("tick");
  };
  const finish = async () => {
    if (!dragging.current) return;
    dragging.current = null;
    setDraggingId(null);
    if (orderRef.current.join() !== savedOrder.join()) {
      await setTasksFlowOrder(orderRef.current);
      syncNow().catch(() => undefined);
    }
  };

  return (
    <div
      className={`mp-day${draggingId ? " is-dragging" : ""}`}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      <div className="mp-day-sum">
        <strong>{dateLabel(date)}</strong>
        <span>予定 {durationText(busy)}・空き {durationText(free)}</span>
      </div>
      {rows.map((row) =>
        row.kind === "gap" ? (
          <button
            key={`gap-${row.start}`}
            type="button"
            className="mp-gap"
            style={{ minHeight: Math.min(96, 34 + (row.end - row.start) / 6) }}
            onClick={() => onCreateAt(date, Math.ceil(row.start / 5) * 5)}
          >
            <span className="mp-time">{hm(row.start)}</span>
            <span>空き {durationText(row.end - row.start)}</span>
            <Plus size={15} />
          </button>
        ) : (
          <div
            key={row.task.id}
            className={`mp-task${isFixed(row.task) ? " fixed" : ""}${draggingId === row.task.id ? " dragging" : ""}${row.entry.conflict ? " conflict" : ""}`}
            {...(!isFixed(row.task) ? { "data-flex-id": row.task.id } : {})}
          >
            <span className="mp-time">
              {hm(row.entry.startMinute)}
              <small>{hm(row.entry.endMinute)}</small>
            </span>
            <button type="button" className="mp-task-main" onClick={() => onMove(row.task)}>
              <strong>{row.task.title}</strong>
              <small>{isFixed(row.task) ? "時刻固定" : "順番で配置"}・{row.task.estimateMin}分</small>
            </button>
            <button type="button" className="mp-play" aria-label={`${row.task.title}を開始`} onClick={() => onStart(row.task)}>
              <Play size={14} />
            </button>
            {!isFixed(row.task) && (
              <span
                className="mp-handle"
                aria-label={`${row.task.title}をドラッグして並べ替え`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  (event.currentTarget.closest(".mp-day") as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
                  dragging.current = row.task.id;
                  setDraggingId(row.task.id);
                }}
              >
                <GripVertical size={18} />
              </span>
            )}
          </div>
        ),
      )}
      {!dayTasks.length && <p className="mp-empty">この日の予定はありません。空き時間を押すと追加できます。</p>}
    </div>
  );
}
