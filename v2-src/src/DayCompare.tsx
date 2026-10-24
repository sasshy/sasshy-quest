import { useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { X } from "lucide-react";
import { db } from "./db";
import { completeTask, createTask, recordPastSession } from "./store";
import { syncNow } from "./sync";
import { localDateKey, mealsOn, MEAL_LABEL } from "./meals";
import type { FocusSession, Memo, Task } from "./types";

/**
 * 日表示の「予定と実際」: what was planned (time-fixed tasks) next to what the
 * timer actually recorded (rounds, interruptions, detours, meals). Gaps with no
 * record can be filled with one tap, so the day becomes readable afterwards.
 */
const PX_PER_MIN = 1.1;
const MIN_GAP = 20;

export interface Block { id: string; start: number; end: number; title: string; kind: "work" | "interrupt" | "detour" | "meal" | "plan" | "gap" }

const minuteOfDay = (ms: number, dayStart: number) => Math.round((ms - dayStart) / 60_000);
const clock = (m: number) => `${Math.floor(m / 60)}:${String(Math.max(0, m % 60)).padStart(2, "0")}`;

export function actualBlocks(sessions: FocusSession[], tasks: Task[], memos: Memo[], date: string, now = Date.now()): Block[] {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = dayStart + 86_400_000;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blocks: Block[] = [];
  for (const s of sessions) {
    if (s.deletedAt) continue;
    const start = Date.parse(s.startedAt);
    const end = s.endedAt ? Date.parse(s.endedAt) : s.status === "paused" && s.pausedAt ? Date.parse(s.pausedAt) : now;
    if (!(end > dayStart && start < dayEnd) || end - start < 60_000) continue;
    const log = byId.get(s.taskId)?.log || s.interrupt?.kind;
    blocks.push({
      id: s.id,
      start: minuteOfDay(Math.max(start, dayStart), dayStart),
      end: minuteOfDay(Math.min(end, dayEnd), dayStart),
      title: s.round?.plan ? `${s.taskTitle}・${s.round.plan}` : s.taskTitle,
      kind: log === "interrupt" ? "interrupt" : log === "detour" ? "detour" : "work",
    });
  }
  for (const m of mealsOn(memos, date)) {
    const at = minuteOfDay(Date.parse(m.meal!.at), dayStart);
    blocks.push({ id: m.id, start: at, end: at + 15, title: `${MEAL_LABEL[m.meal!.kind]} ${m.meal!.item}`, kind: "meal" });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

/** Holes of MIN_GAP minutes or more between the first and the last record (and now, for today). */
export function gapBlocks(actual: Block[], date: string, now = Date.now()): Block[] {
  const work = actual.filter((b) => b.kind !== "meal");
  if (!work.length) return [];
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const last = localDateKey(now) === date ? minuteOfDay(now, dayStart) : work[work.length - 1].end;
  const gaps: Block[] = [];
  let cursor = work[0].start;
  for (const b of [...work, { start: last, end: last } as Block]) {
    if (b.start - cursor >= MIN_GAP) gaps.push({ id: `gap-${cursor}`, start: cursor, end: b.start, title: "記録なし", kind: "gap" });
    cursor = Math.max(cursor, b.end);
  }
  return gaps;
}

/** How long tasks really take compared with the estimate (finished tasks, last 30 days). */
export function estimateBias(tasks: Task[], sessions: FocusSession[], now = Date.now()): { title: string; ratio: number; count: number }[] {
  const since = now - 30 * 86_400_000;
  const worked = new Map<string, number>();
  for (const s of sessions) {
    if (s.deletedAt || !s.endedAt) continue;
    const sec = (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000 - s.pausedTotalSec;
    if (sec > 0) worked.set(s.taskId, (worked.get(s.taskId) || 0) + sec);
  }
  const groups = new Map<string, { sum: number; count: number; title: string }>();
  for (const t of tasks) {
    if (t.deletedAt || t.log || t.status !== "done" || !t.completedAt || Date.parse(t.completedAt) < since) continue;
    const sec = worked.get(t.id);
    if (!sec || t.estimateMin < 5) continue;
    const key = t.title.normalize("NFKC").replace(/\s+/g, "");
    const g = groups.get(key) || { sum: 0, count: 0, title: t.title };
    g.sum += sec / 60 / t.estimateMin;
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .map((g) => ({ title: g.title, ratio: g.sum / g.count, count: g.count }))
    .filter((g) => Math.abs(g.ratio - 1) >= 0.2)
    .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1))
    .slice(0, 3);
}

const FILL_CHOICES: { label: string; log: "interrupt" | "detour" }[] = [
  { label: "休憩", log: "detour" },
  { label: "スマホ", log: "detour" },
  { label: "移動", log: "interrupt" },
  { label: "別の作業", log: "interrupt" },
  { label: "電話・対応", log: "interrupt" },
];

/** Fill a hole afterwards: one tap makes a record for that time range. */
async function fillGap(date: string, gap: Block, label: string, log: "interrupt" | "detour"): Promise<void> {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const startIso = new Date(dayStart + gap.start * 60_000).toISOString();
  const endIso = new Date(dayStart + gap.end * 60_000).toISOString();
  const minutes = gap.end - gap.start;
  const task = await createTask({ title: label, notes: "あとから記録", scheduledDate: date, estimateMin: minutes, durationMin: minutes, log });
  await recordPastSession(task, startIso, endIso, `${clock(gap.start)}〜${clock(gap.end)}を「${label}」として記録`);
  await completeTask(task.id, true);
  syncNow().catch(() => undefined);
}

export function DayCompare({ date }: { date: string }) {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const sessions = useLiveQuery(() => db.sessions.toArray(), [], []) || [];
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const [filling, setFilling] = useState<Block | null>(null);
  const now = Date.now();

  const planned: Block[] = tasks
    .filter((t) => !t.deletedAt && !t.log && t.scheduledDate === date && t.startMinute !== null)
    .map((t) => ({ id: t.id, start: t.startMinute!, end: t.startMinute! + t.estimateMin, title: t.title, kind: "plan" as const }));
  const actual = actualBlocks(sessions, tasks, memos, date, now);
  const gaps = gapBlocks(actual, date, now);
  const all = [...planned, ...actual, ...gaps];
  const isToday = localDateKey(now) === date;
  const nowMin = isToday ? minuteOfDay(now, new Date(`${date}T00:00:00`).getTime()) : null;
  const from = Math.max(0, Math.floor((Math.min(8 * 60, ...all.map((b) => b.start), nowMin ?? 24 * 60) - 30) / 60) * 60);
  const to = Math.min(26 * 60, Math.ceil((Math.max(18 * 60, ...all.map((b) => b.end), nowMin ?? 0) + 30) / 60) * 60);
  const hours = Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from + i * 60);
  const top = (m: number) => (m - from) * PX_PER_MIN;
  const workedMin = actual.filter((b) => b.kind === "work").reduce((s, b) => s + b.end - b.start, 0);
  const awayMin = actual.filter((b) => b.kind === "interrupt" || b.kind === "detour").reduce((s, b) => s + b.end - b.start, 0);
  const bias = estimateBias(tasks, sessions, now);

  const place = (b: Block) => ({ top: top(b.start), height: Math.max(18, (b.end - b.start) * PX_PER_MIN - 2) });

  return (
    <div className="day-compare">
      <div className="dc-summary">
        <div><span>作業</span><strong>{Math.floor(workedMin / 60) ? `${Math.floor(workedMin / 60)}時間` : ""}{workedMin % 60}分</strong></div>
        <div><span>割り込み・寄り道</span><strong>{awayMin}分</strong></div>
        <div><span>記録なし</span><strong>{gaps.reduce((s, g) => s + g.end - g.start, 0)}分</strong></div>
      </div>
      <div className="dc-head"><span /><b>予定</b><b>実際</b></div>
      <div className="dc-grid" style={{ height: (to - from) * PX_PER_MIN }}>
        <div className="dc-hours">
          {hours.map((h) => <span key={h} style={{ top: top(h) }}>{clock(h)}</span>)}
        </div>
        <div className="dc-col">
          {hours.map((h) => <i key={h} className="dc-line" style={{ top: top(h) }} />)}
          {planned.map((b) => (
            <div key={b.id} className="dc-block plan" style={place(b)}><span>{b.title}</span><small>{clock(b.start)}</small></div>
          ))}
          {!planned.length && <p className="dc-empty">時刻を決めた予定はありません</p>}
        </div>
        <div className="dc-col">
          {hours.map((h) => <i key={h} className="dc-line" style={{ top: top(h) }} />)}
          {actual.map((b) => (
            <div key={b.id} className={`dc-block ${b.kind}`} style={place(b)} title={`${clock(b.start)}〜${clock(b.end)} ${b.title}`}>
              <span>{b.title}</span>
              {b.kind !== "meal" && <small>{b.end - b.start}分</small>}
            </div>
          ))}
          {gaps.map((g) => (
            <button key={g.id} type="button" className="dc-block gap" style={place(g)} onClick={() => setFilling(g)}>
              <span>記録なし {g.end - g.start}分</span><small>押して埋める</small>
            </button>
          ))}
          {!actual.length && <p className="dc-empty">この日のタイマー記録はありません</p>}
        </div>
        {nowMin !== null && nowMin >= from && nowMin <= to && <i className="dc-now" style={{ top: top(nowMin) }} />}
      </div>
      <div className="dc-legend"><span><b className="work" />作業</span><span><b className="interrupt" />割り込み</span><span><b className="detour" />寄り道・休憩</span><span><b className="meal" />食事</span></div>
      {bias.length > 0 && (
        <section className="dc-bias">
          <strong>見積もりのクセ（直近30日）</strong>
          {bias.map((b) => (
            <span key={b.title}>「{b.title}」はいつも予定の{b.ratio.toFixed(1)}倍（{b.count}回）</span>
          ))}
        </section>
      )}
      {filling && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setFilling(null); }}>
          <section className="modal-sheet ms2" role="dialog" aria-modal="true" aria-labelledby="fill-title">
            <header>
              <h2 id="fill-title">{clock(filling.start)}〜{clock(filling.end)} は何をしてた？</h2>
              <button className="icon-button" type="button" aria-label="閉じる" onClick={() => setFilling(null)}><X size={20} /></button>
            </header>
            <div className="form-stack">
              <div className="ms-chips">
                {FILL_CHOICES.map((c) => (
                  <button key={c.label} type="button" className="ms-chip" onClick={async () => { const g = filling; setFilling(null); await fillGap(date, g, c.label, c.log); }}>
                    <span>{c.label}</span>
                  </button>
                ))}
              </div>
              <form className="wish-add" onSubmit={async (e) => {
                e.preventDefault();
                const typed = String(new FormData(e.currentTarget).get("what") || "").trim();
                if (!typed) return;
                const g = filling;
                setFilling(null);
                await fillGap(date, g, typed, "interrupt");
              }}>
                <input name="what" placeholder="自分で書く（例：倉庫の整理）" />
                <button className="button primary" type="submit">記録</button>
              </form>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
