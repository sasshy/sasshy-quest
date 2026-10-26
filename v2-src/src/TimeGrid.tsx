import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Play, ZoomIn, ZoomOut } from "lucide-react";
import { byFlow, dayTasksFor, isFixed, planDay } from "./MobilePlanner";
import { shiftDateKey } from "./meals";
import { completeTaskFromActual, createManualFocusSession, updateSession, updateTask } from "./store";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import { localDateKey } from "./work-start";
import type { FocusSession, Task } from "./types";

/**
 * 時間の目盛りの表示（日 / 3日）: tasks sit on a time grid like a calendar app.
 * Free time between them is shown ("空き 1時間30分", tap to add there).
 * Long-press a block to move it (also to another day in 3日), drag its bottom
 * edge to change the length. Moving pins the task to that time.
 *
 * 上の棚には時間未定のタスクと前の日の残りが並ぶ。長押しでつかんで枠に置くと
 * その時間の予定になり、今より前に置くと「その時間にやった」記録（完了）になる。
 * やった記録（緑）も同じように長押しで動かし、下の端で長さを変えられる。
 * つかんだまま左右の端で少し待つと前の日・次の日へめくれる（表示外の日へも運べる）。
 * 何もつかんでいないときは、横にスワイプで前後の日（3日なら3日ずつ）へ。
 */
const FROM = 6 * 60;
const TO = 24 * 60;
// 1分あたりの高さ（px）。細かいタスクが見えるよう、拡大縮小できる。
const ZOOMS = [1, 1.6, 2.4, 3.4];
const loadZoom = () => {
  try { const v = Number(localStorage.getItem("sasshy-grid-zoom")); return ZOOMS.includes(v) ? v : 1.6; } catch { return 1.6; }
};
const SNAP = 15;
const HOLD_MS = 350;

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const durationText = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}` : `${min}分`);
const snap = (m: number, step = SNAP) => Math.round(m / step) * step;
const minuteOf = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
const dateAt = (date: string, minute: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 0, minute).toISOString();
};
// やった記録は短くても指でつかめる高さで出す（実際の長さは変えない）。
const MIN_SHOWN = 15;
const toast = (text: string) => window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: text }));
interface TrayDrag { task: Task; startX: number; startY: number; x: number; y: number; active: boolean; date: string | null; start: number }

interface Placed { task: Task; date: string; start: number; end: number; fixed: boolean; session?: FocusSession }
interface Drag { id: string; kind: "move" | "resize"; startY: number; startX: number; grabY: number; orig: Placed; start: number; end: number; date: string; active: boolean }

export function TimeGrid({
  tasks,
  sessions = [],
  dates,
  onCreateAt,
  onOpen,
  onStart,
  onPage,
  onSwipe,
}: {
  tasks: Task[];
  sessions?: FocusSession[];
  /** つかんだまま端に寄せたとき、表示する日を前後にずらす。 */
  onPage?: (delta: number) => void;
  /** 横スワイプ：-1 = 前へ、1 = 次へ。 */
  onSwipe?: (dir: -1 | 1) => void;
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
  const [PX, setPX] = useState(loadZoom);
  const zoom = (dir: 1 | -1) => {
    const i = Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(PX) + dir));
    const el = scrollRef.current;
    const ratio = ZOOMS[i] / PX;
    setPX(ZOOMS[i]);
    try { localStorage.setItem("sasshy-grid-zoom", String(ZOOMS[i])); } catch { /* 覚えられなくても表示はできる */ }
    if (el) requestAnimationFrame(() => { el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2; });
  };
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const holdTimer = useRef<number | null>(null);
  const [trayDrag, setTrayDrag] = useState<TrayDrag | null>(null);
  const trayRef = useRef<TrayDrag | null>(null);
  const trayHold = useRef<number | null>(null);
  const setTray = (v: TrayDrag | null) => { trayRef.current = v; setTrayDrag(v); };

  // 最初は「今」か朝8時あたりが見えるように。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const focus = dates.includes(today) ? now.getHours() * 60 + now.getMinutes() - 90 : 8 * 60;
    // つかんだまま日をめくったときは、時間の位置をそのままにする。
    if (dragRef.current?.active || trayRef.current?.active) return;
    el.scrollTop = Math.max(0, top(focus));
  }, [dates.join()]);

  const columns = dates.map((date) => {
    const dayTasks = dayTasksFor(tasks, date);
    const order = dayTasks.filter((t) => !isFixed(t)).sort(byFlow).map((t) => t.id);
    const plan = planDay(dayTasks, date, order, now);
    const placed: Placed[] = plan.rows
      .filter((r): r is Extract<typeof r, { kind: "task" }> => r.kind === "task")
      .map((r) => ({ task: r.task, date, start: r.entry.startMinute, end: r.entry.endMinute, fixed: isFixed(r.task) }));
    const gaps = plan.rows.filter((r): r is Extract<typeof r, { kind: "gap" }> => r.kind === "gap" && r.end - r.start >= 15);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const actual: Placed[] = sessions
      .filter((s) => !s.deletedAt && s.endedAt && (s.status === "completed" || s.status === "interrupted") && localDateKey(new Date(s.startedAt)) === date)
      .flatMap((s) => {
        const task = byId.get(s.taskId);
        if (!task || task.deletedAt) return [];
        const start = minuteOf(s.startedAt);
        const realEnd = Math.max(start + 1, start + Math.round((Date.parse(s.endedAt!) - Date.parse(s.startedAt)) / 60_000));
        return [{ task, date, start, end: Math.max(realEnd, start + MIN_SHOWN), fixed: false, session: s }];
      });
    return { date, placed, actual, gaps, busy: plan.busy, free: plan.free };
  });

  // 細かいタスクがある時間だけ、自動で縦に広げる（1時間ごとに高さを決める）。
  const MIN_BLOCK = 26;
  const hourPx = Array.from({ length: (TO - FROM) / 60 }, (_, i) => {
    const h0 = FROM + i * 60;
    let need = 60 * PX;
    for (const c of columns) for (const p of c.placed) {
      if (p.end <= h0 || p.start >= h0 + 60) continue;
      const d = Math.max(1, p.end - p.start);
      if (d < 60) need = Math.max(need, (MIN_BLOCK * 60) / d);
    }
    return Math.min(need, 420);
  });
  const hourTop = hourPx.reduce<number[]>((acc, h, i) => { acc.push((acc[i - 1] ?? 0) + (i ? hourPx[i - 1] : 0)); return acc; }, []);
  const top = (m: number) => {
    const c = Math.min(TO, Math.max(FROM, m));
    const i = Math.min(hourPx.length - 1, Math.floor((c - FROM) / 60));
    return hourTop[i] + ((c - FROM - i * 60) / 60) * hourPx[i];
  };
  const minuteAt = (y: number) => {
    for (let i = 0; i < hourPx.length; i += 1) {
      if (y < hourTop[i] + hourPx[i] || i === hourPx.length - 1) return FROM + i * 60 + Math.max(0, Math.min(60, ((y - hourTop[i]) / hourPx[i]) * 60));
    }
    return TO;
  };
  const totalHeight = hourTop[hourTop.length - 1] + hourPx[hourPx.length - 1];

  const colWidth = () => {
    const grid = gridRef.current;
    if (!grid) return 1;
    return (grid.getBoundingClientRect().width - 40) / dates.length;
  };

  const columnAt = (x: number) => {
    const grid = gridRef.current;
    if (!grid) return dates[0];
    const r = grid.getBoundingClientRect();
    return dates[Math.min(dates.length - 1, Math.max(0, Math.floor((x - r.left - 40) / colWidth())))];
  };
  // ---- 端で待つと日をめくる ----
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const edgeTimer = useRef<number | null>(null);
  const edgeDir = useRef(0);
  const stopEdge = () => {
    if (edgeTimer.current) window.clearTimeout(edgeTimer.current);
    edgeTimer.current = null;
    edgeDir.current = 0;
    setEdgeArmed(0);
  };
  const [edgeArmed, setEdgeArmed] = useState(0);
  const checkEdge = (x: number) => {
    const grid = gridRef.current;
    if (!grid || !onPage) return;
    const r = grid.getBoundingClientRect();
    const dir = x < r.left + 40 + 30 ? -1 : x > r.right - 44 ? 1 : 0;
    if (dir === edgeDir.current) return;
    stopEdge();
    edgeDir.current = dir;
    setEdgeArmed(dir);
    if (!dir) return;
    const flip = () => {
      onPage(dir);
      haptic("tick");
      edgeTimer.current = window.setTimeout(flip, 800);
    };
    edgeTimer.current = window.setTimeout(flip, 420);
  };
  useEffect(() => stopEdge, []);
  // めくった後は、指が止まっていても置き先の日を新しい表示に合わせる。
  useEffect(() => { retarget(); }, [dates.join()]);

  const begin = (event: ReactPointerEvent, p: Placed, kind: Drag["kind"]) => {
    const gridTop = gridRef.current?.getBoundingClientRect().top ?? 0;
    const grabY = event.clientY - gridTop - top(p.start);
    const d: Drag = { id: p.session?.id || p.task.id, kind, startY: event.clientY, startX: event.clientX, grabY, orig: p, start: p.start, end: p.end, date: p.date, active: kind === "resize" };
    dragRef.current = d;
    if (kind === "resize") {
      setDrag(d);
      try { (gridRef.current || (event.currentTarget as HTMLElement)).setPointerCapture?.(event.pointerId); } catch { /* 同上 */ }
      haptic("tick");
      return;
    }
    // つかんだブロックは日をめくると消えるので、ずっと残る枠のほうで指を追う。
    const target = gridRef.current || (event.currentTarget as HTMLElement);
    const pointerId = event.pointerId;
    holdTimer.current = window.setTimeout(() => {
      if (!dragRef.current) return;
      dragRef.current = { ...dragRef.current, active: true };
      setDrag(dragRef.current);
      try { target.setPointerCapture?.(pointerId); } catch { /* 指が離れていたら掴まない */ }
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
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (d.kind === "move") checkEdge(event.clientX);
    retarget();
  };

  /** 指の位置（画面上）から置き先を決め直す。スクロール中・日をめくった後も呼ぶ。 */
  const retarget = () => {
    const pos = lastPointer.current;
    const grid = gridRef.current;
    if (!pos || !grid) return;
    const gridTop = grid.getBoundingClientRect().top;
    const d = dragRef.current;
    if (d?.active) {
      let next: Drag;
      if (d.kind === "resize") {
        next = { ...d, end: Math.max(d.orig.start + 5, snap(minuteAt(pos.y - gridTop), 5)) };
      } else {
        const length = d.orig.end - d.orig.start;
        const start = Math.min(TO - length, Math.max(FROM, snap(minuteAt(pos.y - gridTop - d.grabY), d.orig.session ? 5 : SNAP)));
        next = { ...d, start, end: start + length, date: columnAt(pos.x) };
      }
      if (next.start !== d.start || next.end !== d.end || next.date !== d.date) {
        haptic("tick");
        dragRef.current = next;
        setDrag(next);
      }
      return;
    }
    const t = trayRef.current;
    if (t?.active) {
      const target = trayTarget(pos.x, pos.y);
      if (target.date !== t.date || target.start !== t.start) haptic("tick");
      setTray({ ...t, x: pos.x, y: pos.y, ...target });
    }
  };

  // つかんでいる間：画面のスクロールを止め、上下の端に来たら自動でスクロールする。
  const dragging = Boolean(drag?.active || trayDrag?.active);
  useEffect(() => {
    if (!dragging) return;
    const stopScroll = (e: TouchEvent) => e.preventDefault();
    document.addEventListener("touchmove", stopScroll, { passive: false });
    document.body.classList.add("sasshy-dragging");
    let frame = 0;
    const tick = () => {
      const el = scrollRef.current;
      const pos = lastPointer.current;
      if (el && pos) {
        const box = el.getBoundingClientRect();
        const zone = 70;
        let speed = 0;
        if (pos.y > box.bottom - zone) speed = Math.min(1, (pos.y - (box.bottom - zone)) / zone);
        else if (pos.y < box.top + zone) speed = -Math.min(1, ((box.top + zone) - pos.y) / zone);
        if (speed) {
          const before = el.scrollTop;
          el.scrollTop += speed * 16;
          if (el.scrollTop !== before) retarget();
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("touchmove", stopScroll);
      document.body.classList.remove("sasshy-dragging");
    };
  }, [dragging]);

  const cancelHold = () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    if (dragRef.current && !dragRef.current.active) dragRef.current = null;
  };

  const end = async () => {
    cancelHold();
    stopEdge();
    lastPointer.current = null;
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d || !d.active) return;
    const s = d.orig.session;
    if (s) {
      // やった記録を動かす・長さを変える（完了の時刻も合わせる）。
      if (d.start === d.orig.start && d.end === d.orig.end && d.date === d.orig.date) return;
      const realLen = Math.max(1, Math.round((Date.parse(s.endedAt!) - Date.parse(s.startedAt)) / 60_000));
      const startedAt = dateAt(d.date, d.start);
      const len = d.kind === "resize" ? Math.max(5, d.end - d.start) : realLen;
      const endedAt = new Date(Date.parse(startedAt) + len * 60_000).toISOString();
      await updateSession(s.id, { startedAt, endedAt, pausedTotalSec: 0, pausedAt: null }, d.kind === "resize" ? `実績を${len}分に変更` : `実績を${hm(d.start)}に移動`);
      if (d.orig.task.status === "done") await updateTask(d.orig.task.id, { completedAt: endedAt }, "完了時刻を実績に合わせる", false);
      syncNow().catch(() => undefined);
      return;
    }
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

  // ---- 上の棚（時間未定・前の日の残り）から引っぱってくる ----
  const tray = tasks
    .filter((t) => !t.deletedAt && !t.log && t.status !== "done" && t.status !== "archived" && t.status !== "active"
      && ((!t.scheduledDate && t.horizon === "now") || (t.scheduledDate !== null && t.scheduledDate < today)))
    .sort((a, b) => (a.scheduledDate || "9").localeCompare(b.scheduledDate || "9"));
  const trayTarget = (x: number, y: number): { date: string | null; start: number } => {
    const grid = gridRef.current;
    if (!grid) return { date: null, start: 0 };
    const r = grid.getBoundingClientRect();
    const scrollBox = scrollRef.current?.getBoundingClientRect();
    if (x < r.left || x > r.right || (scrollBox && (y < scrollBox.top || y > scrollBox.bottom))) return { date: null, start: 0 };
    const index = Math.min(dates.length - 1, Math.max(0, Math.floor((x - r.left - 40) / colWidth())));
    return { date: dates[index], start: Math.min(TO - 15, Math.max(FROM, snap(minuteAt(y - r.top)))) };
  };
  const trayDown = (event: ReactPointerEvent, task: Task) => {
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    trayRef.current = { task, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, date: null, start: 0 };
    trayHold.current = window.setTimeout(() => {
      if (!trayRef.current) return;
      try { target.setPointerCapture?.(pointerId); } catch { /* 指が離れていたら掴まない */ }
      setTray({ ...trayRef.current, active: true });
      haptic("tick");
    }, HOLD_MS);
  };
  const trayMove = (event: ReactPointerEvent) => {
    const t = trayRef.current;
    if (!t) return;
    if (!t.active) {
      // 長押しの前に指が動いたら棚のスクロール。
      if (Math.abs(event.clientX - t.startX) > 8 || Math.abs(event.clientY - t.startY) > 8) {
        if (trayHold.current) window.clearTimeout(trayHold.current);
        trayRef.current = null;
      }
      return;
    }
    event.preventDefault();
    lastPointer.current = { x: event.clientX, y: event.clientY };
    checkEdge(event.clientX);
    retarget();
  };
  const trayUp = async () => {
    if (trayHold.current) window.clearTimeout(trayHold.current);
    stopEdge();
    lastPointer.current = null;
    const t = trayRef.current;
    setTray(null);
    if (!t?.active || !t.date) return;
    const task = t.task;
    const len = Math.max(5, task.estimateMin || 15);
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    const past = t.date < today || (t.date === today && t.start < nowMinute);
    if (past) {
      // 今より前に置いた = その時間にやった。実績を残して完了にする。
      const endMin = t.date === today ? Math.min(t.start + len, Math.max(t.start + 5, nowMinute)) : t.start + len;
      const added = await createManualFocusSession(task, dateAt(t.date, t.start), dateAt(t.date, endMin));
      await completeTaskFromActual(task.id, added.endedAt!, added.id);
      haptic("success");
      toast(`✓「${task.title}」を${hm(t.start)}〜${hm(endMin)}にやったことにしました`);
    } else {
      await updateTask(task.id, { scheduledDate: t.date, startMinute: t.start, isFixed: true, status: "planned" }, `${hm(t.start)}に予定`);
    }
    syncNow().catch(() => undefined);
  };

  // ---- 横スワイプで日をめくる（つかんでいないときだけ） ----
  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  const [slide, setSlide] = useState<0 | -1 | 1>(0);
  const swipeDown = (event: ReactPointerEvent) => {
    swipe.current = { x: event.clientX, y: event.clientY, at: Date.now() };
  };
  const swipeUp = (event: ReactPointerEvent) => {
    const sw = swipe.current;
    swipe.current = null;
    if (!sw || !onSwipe || dragRef.current?.active || trayRef.current?.active) return;
    const dx = event.clientX - sw.x;
    const dy = event.clientY - sw.y;
    if (Math.abs(dx) < 55 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - sw.at > 700) return;
    // 画面の左端から右へのスワイプはメニューを開く操作なので、日はめくらない。
    if (sw.x < 28 && dx > 0) return;
    const dir = dx < 0 ? 1 : -1;
    cancelHold();
    setSlide(dir);
    onSwipe(dir);
    haptic("tick");
  };
  useEffect(() => {
    if (!slide) return;
    const t = window.setTimeout(() => setSlide(0), 260);
    return () => window.clearTimeout(t);
  }, [slide, dates.join()]);

  const hours = Array.from({ length: (TO - FROM) / 60 + 1 }, (_, i) => FROM + i * 60);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div className={`tg${trayDrag?.active ? " tray-dragging" : ""}`}>
      {tray.length > 0 && (
        <div className="tg-tray" aria-label="時間未定のタスク（長押しでつかんで時間の枠へ）">
          <span className="tg-tray-label">時間未定</span>
          {tray.map((t) => (
            <span
              key={t.id}
              className={`tg-chip${trayDrag?.active && trayDrag.task.id === t.id ? " held" : ""}${t.scheduledDate ? " late" : ""}`}
              onPointerDown={(e) => trayDown(e, t)}
              onPointerMove={trayMove}
              onPointerUp={trayUp}
              onPointerCancel={trayUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              {t.title}<small>{t.scheduledDate ? `${Number(t.scheduledDate.slice(5, 7))}/${Number(t.scheduledDate.slice(8))}の残り` : `${t.estimateMin}分`}</small>
            </span>
          ))}
        </div>
      )}
      {trayDrag?.active && (
        <span className="tg-chip tg-ghost" style={{ left: trayDrag.x, top: trayDrag.y }}>{trayDrag.task.title}</span>
      )}
      <div className="tg-head" style={{ gridTemplateColumns: `40px repeat(${dates.length}, minmax(0, 1fr))` }}>
        <span className="tg-zoom">
          <button type="button" aria-label="時間の目盛りを縮める（1日を広く見る）" title="縮める" disabled={PX === ZOOMS[0]} onClick={() => zoom(-1)}><ZoomOut size={15} /></button>
          <button type="button" aria-label="時間の目盛りを広げる（細かく見る）" title="広げる" disabled={PX === ZOOMS[ZOOMS.length - 1]} onClick={() => zoom(1)}><ZoomIn size={15} /></button>
        </span>
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
      {dragging && onPage && (
        <>
          <span className={`tg-edge left${edgeArmed < 0 ? " armed" : ""}`}>‹ {Number(shiftDateKey(dates[0], -1).slice(8))}日</span>
          <span className={`tg-edge right${edgeArmed > 0 ? " armed" : ""}`}>{Number(shiftDateKey(dates[dates.length - 1], 1).slice(8))}日 ›</span>
        </>
      )}
      <div className={`tg-scroll${slide ? ` slide-${slide > 0 ? "next" : "prev"}` : ""}`} ref={scrollRef} onPointerDown={swipeDown} onPointerUp={swipeUp} onPointerCancel={() => { swipe.current = null; }}>
        <div
          className={`tg-grid${drag?.active ? " dragging" : ""}`}
          ref={gridRef}
          style={{ height: totalHeight, gridTemplateColumns: `40px repeat(${dates.length}, minmax(0, 1fr))` }}
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
              {/* 過ぎた時間：ここに置くと「やった」記録になる */}
              {(c.date < today || c.date === today) && (
                <i className="tg-past" style={{ top: 0, height: c.date < today ? totalHeight : top(Math.max(FROM, nowMin)) }} />
              )}
              {c.actual.map((p) => {
                const live = drag?.active && drag.id === p.session!.id ? drag : null;
                if (live && live.date !== c.date) return null;
                const start = live ? live.start : p.start;
                const endMin = live ? live.end : p.end;
                return (
                  <div
                    key={p.session!.id}
                    className={`tg-block done${live ? " lifted" : ""}${top(endMin) - top(start) < 34 ? " short" : ""}${c.placed.some((pl) => pl.start < endMin && pl.end > start) ? " beside" : ""}`}
                    style={{ top: top(start), height: Math.max(22, top(endMin) - top(start) - 2) }}
                    onPointerDown={(e) => begin(e, p, "move")}
                  >
                    <button type="button" className="tg-title" onClick={() => { if (!dragRef.current?.active) onOpen(p.task); }}>
                      <strong>✓ {p.task.title}</strong>
                      <small>{hm(start)}〜{hm(live ? endMin : minuteOf(p.session!.endedAt!))}</small>
                    </button>
                    <span className="tg-resize" aria-label="下を引っぱって長さを変える" onPointerDown={(e) => { e.stopPropagation(); begin(e, p, "resize"); }} />
                  </div>
                );
              })}
              {trayDrag?.active && trayDrag.date === c.date && (
                <div className={`tg-block lifted${trayDrag.date < today || (trayDrag.date === today && trayDrag.start < nowMin) ? " done" : ""}`} style={{ top: top(trayDrag.start), height: Math.max(22, top(trayDrag.start + Math.max(15, trayDrag.task.estimateMin)) - top(trayDrag.start) - 2) }}>
                  <span className="tg-title"><strong>{trayDrag.task.title}</strong><small>{hm(trayDrag.start)}{trayDrag.date < today || (trayDrag.date === today && trayDrag.start < nowMin) ? " やった" : " 予定"}</small></span>
                </div>
              )}
              {c.gaps.map((g) => (
                <button key={`g${g.start}`} type="button" className="tg-gap" style={{ top: top(g.start) + 1, height: Math.max(16, top(g.end) - top(g.start) - 2) }} onClick={() => onCreateAt(c.date, Math.ceil(g.start / 5) * 5)}>
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
                    className={`tg-block${p.fixed ? " fixed" : ""}${live ? " lifted" : ""}${p.task.status === "active" ? " running" : ""}${top(endMin) - top(start) < 34 ? " short" : ""}`}
                    style={{ top: top(start), height: Math.max(22, top(endMin) - top(start) - 2) }}
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
                <div className={`tg-block lifted${drag.orig.session ? " done" : ""}`} style={{ top: top(drag.start), height: Math.max(22, top(drag.end) - top(drag.start) - 2) }}>
                  <span className="tg-title"><strong>{drag.orig.task.title}</strong><small>{hm(drag.start)}</small></span>
                </div>
              )}
              {c.date === today && nowMin >= FROM && nowMin <= TO && <i className="tg-now" style={{ top: top(nowMin) }} />}
            </div>
          ))}
        </div>
      </div>
      <p className="tg-hint">長押しで移動・下の端で長さ・上の棚から置ける（過ぎた時間に置くと「やった」）</p>
    </div>
  );
}

export function threeDays(date: string): string[] {
  return [date, shiftDateKey(date, 1), shiftDateKey(date, 2)];
}
