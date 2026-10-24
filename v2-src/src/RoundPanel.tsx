import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Coffee, PhoneIncoming, Shuffle, X } from "lucide-react";
import { db } from "./db";
import { completeTask, createTask, updateSession } from "./store";
import { syncNow } from "./sync";
import { localDateKey } from "./meals";
import { sessionRemainingSec } from "./TwoMinute";
import { isStale } from "./StaleSession";
import {
  DETOUR_CHOICES,
  INTERRUPT_CHOICES,
  getRoundBreak,
  planSuggestions,
  setRoundBreak,
} from "./rounds";
import type { FocusSession } from "./types";

export interface StartOptions { starter?: boolean; plan?: string; leftMin?: number; interrupt?: FocusSession["interrupt"] }

/** Ask App to start a task timer (App owns voice, haptics and the timer view). */
export function requestStart(taskId: string, opts: StartOptions = {}): void {
  window.dispatchEvent(new CustomEvent("sasshy-start-task", { detail: { id: taskId, ...opts } }));
}

/** Pause the current work and time the interruption / detour instead. */
async function beginInterrupt(session: FocusSession, kind: "interrupt" | "detour", label: string): Promise<void> {
  const leftMin = Math.max(1, Math.ceil(sessionRemainingSec(session) / 60));
  const task = await createTask({
    title: `${kind === "interrupt" ? "割り込み" : "寄り道"}：${label}`,
    notes: `「${session.taskTitle}」の途中`,
    scheduledDate: localDateKey(Date.now()),
    estimateMin: kind === "detour" ? 5 : 10,
    durationMin: kind === "detour" ? 5 : 10,
    log: kind,
  });
  requestStart(task.id, {
    interrupt: { kind, returnTaskId: session.taskId, returnTitle: session.taskTitle, returnLeftMin: leftMin, returnPlan: session.round?.plan || "" },
  });
  syncNow().catch(() => undefined);
}

/** Back from an interruption: continue the round, start a fresh round, or stop for today. */
export async function returnFromInterrupt(session: FocusSession, mode: "continue" | "fresh" | "stop"): Promise<void> {
  const back = session.interrupt!;
  await updateSession(session.id, { status: "completed", endedAt: new Date().toISOString(), pausedAt: null }, "割り込みおわり");
  await completeTask(session.taskId, true);
  if (mode === "continue") requestStart(back.returnTaskId, { leftMin: back.returnLeftMin, plan: back.returnPlan });
  if (mode === "fresh") requestStart(back.returnTaskId, { plan: back.returnPlan });
  syncNow().catch(() => undefined);
}

function InterruptSheet({ session, kind, onClose }: { session: FocusSession; kind: "interrupt" | "detour"; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);
  const choices = kind === "interrupt" ? INTERRUPT_CHOICES : DETOUR_CHOICES;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2 interrupt-sheet" role="dialog" aria-modal="true" aria-labelledby="interrupt-title">
        <header>
          <h2 id="interrupt-title">{kind === "interrupt" ? "何が入った？" : "気がそれた"}</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">
          {kind === "detour" && (
            <form className="wish-add" onSubmit={async (e) => {
              e.preventDefault();
              const typed = String(new FormData(e.currentTarget).get("thought") || "").trim();
              if (!typed) return;
              await createTask({ title: typed, notes: `「${session.taskTitle}」の途中で思いついた` });
              setNote("");
              setSaved(true);
              syncNow().catch(() => undefined);
            }}>
              <input name="thought" value={note} onChange={(e) => { setNote(e.target.value); setSaved(false); }} placeholder="頭に浮かんだことを書いて、作業に戻る" />
              <button className="button primary" type="submit">メモ</button>
            </form>
          )}
          {saved && <p className="ms-toast">「やること」に入れました。作業に戻ろう</p>}
          <span className="meal-label">{kind === "interrupt" ? "選ぶと今の作業は一時停止。割り込みの時間も記録します" : "見るなら5分だけ。時間を決めて寄り道する"}</span>
          <div className="ms-chips">
            {choices.map((c) => (
              <button key={c} type="button" className="ms-chip" onClick={async () => { onClose(); await beginInterrupt(session, kind, c); }}>
                <span>{c}</span>
              </button>
            ))}
          </div>
          {kind === "detour" && saved && <button type="button" className="button secondary" onClick={onClose}>作業に戻る</button>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Inside the timer: round progress, what this round is for, and the two "something happened" buttons. */
export function RoundBar({ session }: { session: FocusSession }) {
  const [sheet, setSheet] = useState<"interrupt" | "detour" | null>(null);
  const [plan, setPlan] = useState(session.round?.plan || "");
  useEffect(() => setPlan(session.round?.plan || ""), [session.id, session.round?.plan]);
  // 打ったら少し待って保存（フォーカスが外れなくても消えないように）。
  useEffect(() => {
    const r = session.round;
    const typed = plan.trim().slice(0, 80);
    if (!r || typed === r.plan) return;
    const timer = window.setTimeout(() => {
      updateSession(session.id, { round: { ...r, plan: typed } }, "ラウンドの内容").catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [plan]);
  const back = session.interrupt;
  if (back) {
    return (
      <div className="round-bar interrupt">
        <span className="round-label">{back.kind === "detour" ? "寄り道中" : "割り込み中"}・元の作業：{back.returnTitle}</span>
        <button type="button" className="round-main" onClick={() => returnFromInterrupt(session, "continue")}>
          おわった → 続きから（残り{back.returnLeftMin}分）
        </button>
        <div className="round-row">
          <button type="button" onClick={() => returnFromInterrupt(session, "fresh")}>仕切り直す（15分）</button>
          <button type="button" onClick={() => returnFromInterrupt(session, "stop")}>今日はやめる</button>
        </div>
      </div>
    );
  }
  const r = session.round;
  return (
    <div className="round-bar">
      {r && (
        <>
          <div className="round-seg" aria-label={`ラウンド ${r.index} / ${r.total}`}>
            {Array.from({ length: Math.min(r.total, 12) }, (_, i) => (
              <i key={i} className={i + 1 < r.index ? "done" : i + 1 === r.index ? "now" : ""} />
            ))}
          </div>
          <label className="round-plan">
            <span>ラウンド {r.index} / {r.total}・このラウンドでやること</span>
            <input
              value={plan}
              placeholder="例：A社の5箱を詰める"
              onChange={(e) => setPlan(e.target.value)}
              onBlur={(e) => {
                const typed = e.currentTarget.value.trim().slice(0, 80);
                if (typed !== r.plan) updateSession(session.id, { round: { ...r, plan: typed } }, "ラウンドの内容").catch(() => undefined);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
          </label>
        </>
      )}
      <div className="round-row">
        <button type="button" onClick={() => setSheet("interrupt")}><PhoneIncoming size={15} /> 割り込みが入った</button>
        <button type="button" onClick={() => setSheet("detour")}><Shuffle size={15} /> 気がそれた</button>
      </div>
      {sheet && <InterruptSheet session={session} kind={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** End of a round: 10 seconds to say how it went and what the next 15 minutes are for. */
export function RoundEndPrompt() {
  const session = useLiveQuery(
    () => db.sessions.where("status").equals("running").filter((s) => Boolean(s.round) && !s.interrupt && !s.deletedAt).first(),
    [],
    undefined,
  );
  const task = useLiveQuery(async () => (session ? db.tasks.get(session.taskId) : undefined), [session?.taskId], undefined);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<"done" | "half" | "not" | null>(null);
  const [next, setNext] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session?.id]);
  const due = Boolean(session && task && sessionRemainingSec(session, now) <= 0 && !isStale(session, now));
  useEffect(() => {
    setResult(null);
    setNext("");
    if (due && session && task) planSuggestions(task, session).then(setSuggestions).catch(() => setSuggestions([]));
  }, [due, session?.id]);
  if (!due || !session || !task) return null;
  const r = session.round!;

  const closeRound = async (status: "completed" | "interrupted") => {
    await updateSession(session.id, { status, endedAt: new Date().toISOString(), pausedAt: null, round: { ...r, result: result || r.result } }, `ラウンド${r.index}おわり`);
  };
  const nextRound = async () => {
    await closeRound("interrupted");
    requestStart(task.id, { plan: next || (result !== "done" ? r.plan : "") });
    syncNow().catch(() => undefined);
  };
  const takeBreak = async () => {
    await closeRound("interrupted");
    await setRoundBreak({ taskId: task.id, title: task.title, until: new Date(Date.now() + 5 * 60_000).toISOString(), plan: next || (result !== "done" ? r.plan : "") });
    syncNow().catch(() => undefined);
  };
  const finishTask = async () => {
    await closeRound("completed");
    await completeTask(task.id, true);
    syncNow().catch(() => undefined);
  };
  const stopToday = async () => {
    await closeRound("interrupted");
    syncNow().catch(() => undefined);
  };

  return createPortal(
    <div className="stale" role="dialog" aria-modal="true" aria-labelledby="round-end-title">
      <div className="stale-card round-end">
        <h2 id="round-end-title">ラウンド{r.index} おわり</h2>
        <span className="stale-q">{r.plan ? `「${r.plan}」どうだった？` : "このラウンド、どうだった？"}</span>
        <div className="round-results" role="group" aria-label="結果">
          {([["done", "できた"], ["half", "半分"], ["not", "まだ"]] as const).map(([v, label]) => (
            <button key={v} type="button" className={result === v ? "picked" : ""} aria-pressed={result === v} onClick={() => setResult(v)}>{label}</button>
          ))}
        </div>
        <span className="stale-q">次の{r.index < r.total ? "15分" : "ラウンド"}は？</span>
        <div className="round-next">
          {suggestions.filter((s) => !(result === "done" && s === r.plan)).map((s) => (
            <button key={s} type="button" className={next === s ? "picked" : ""} onClick={() => setNext(s)}>
              {s}{s === r.plan ? "（続き）" : ""}
            </button>
          ))}
          <input value={next} onChange={(e) => setNext(e.target.value)} placeholder="書く（空でもOK）" aria-label="次のラウンドでやること" />
        </div>
        <div className="stale-actions">
          <button type="button" className="primary" onClick={nextRound}>次のラウンドへ</button>
          <button type="button" onClick={takeBreak}><Coffee size={15} /> 休憩5分</button>
        </div>
        <div className="stale-links">
          <button type="button" onClick={finishTask}>この作業は完了</button>
          <button type="button" onClick={stopToday}>今日はここまで</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Today: a break between rounds, with the way back. */
export function RoundBreakBanner() {
  const brk = useLiveQuery(async () => { await db.settings.get("roundBreak"); return getRoundBreak(); }, [], null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!brk) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [brk?.taskId]);
  if (!brk) return null;
  const left = Math.ceil((Date.parse(brk.until) - now) / 1000);
  const resume = async () => {
    await setRoundBreak(null);
    requestStart(brk.taskId, { plan: brk.plan });
  };
  return (
    <section className={`round-break${left <= 0 ? " over" : ""}`} aria-live="polite">
      <Coffee size={18} />
      <div>
        <strong>{left > 0 ? `休憩 あと${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "休憩おわり"}</strong>
        <small>次：{brk.title}{brk.plan ? `・${brk.plan}` : ""}</small>
      </div>
      <button type="button" onClick={resume}>次のラウンド</button>
      <button type="button" className="quiet" aria-label="休憩をやめて閉じる" onClick={() => setRoundBreak(null)}><X size={16} /></button>
    </section>
  );
}

