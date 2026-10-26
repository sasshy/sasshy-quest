import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { completeTask, softDeleteTask, updateTask } from "./store";
import { syncNow } from "./sync";
import { haptic } from "./feedback";
import { ageDays, markTriaged } from "./triage";
import { localDateKey } from "./work-start";
import type { Task } from "./types";

/** 片付けモード：1件ずつ出して、今日／明日／いつか／やった／あとで／消す を押すだけ。 */
const ageText = (days: number) => (days === 0 ? "今日入れた" : days < 7 ? `${days}日前に入れた` : days < 60 ? `${Math.floor(days / 7)}週間前に入れた` : `${Math.floor(days / 30)}か月前に入れた`);

export function TriageSheet({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  // 開いた時点の並び（古い順）で固定。途中で一覧が変わってもカードが飛ばない。
  const queue = useMemo(() => [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), []);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState({ moved: 0, finished: 0, removed: 0 });
  const [armed, setArmed] = useState(false);
  const task = queue[index];
  const next = (kind?: keyof typeof done) => {
    if (kind) setDone((d) => ({ ...d, [kind]: d[kind] + 1 }));
    setArmed(false);
    setIndex((i) => i + 1);
    syncNow().catch(() => undefined);
  };
  const close = () => {
    markTriaged();
    onClose();
  };
  const today = localDateKey(new Date());
  const tomorrow = localDateKey(new Date(Date.now() + 86_400_000));

  return createPortal(
    <div className="modal-backdrop triage-backdrop" role="presentation">
      <section className="modal-sheet triage" role="dialog" aria-modal="true" aria-label="やることを片付ける">
        <header>
          <h2>片付ける</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={close}><X size={20} /></button>
        </header>
        <div className="triage-prog"><i style={{ width: `${(Math.min(index, queue.length) / Math.max(1, queue.length)) * 100}%` }} /></div>
        {task ? (
          <>
            <div className="triage-card" key={task.id}>
              <small>{ageText(ageDays(task))}</small>
              <strong>{task.title}</strong>
              {task.notes && <p>{task.notes.slice(0, 120)}</p>}
            </div>
            <div className="triage-btns">
              <button type="button" onClick={async () => { haptic("tap"); await updateTask(task.id, { scheduledDate: today, horizon: "now" }, "片付け：今日やる"); next("moved"); }}>今日</button>
              <button type="button" onClick={async () => { haptic("tap"); await updateTask(task.id, { scheduledDate: tomorrow, horizon: "now" }, "片付け：明日やる"); next("moved"); }}>明日</button>
              <button type="button" onClick={async () => { haptic("tap"); await updateTask(task.id, { horizon: "someday" }, "片付け：いつかへ"); next("moved"); }}>いつか</button>
              <button type="button" className="done" onClick={async () => { haptic("success"); await completeTask(task.id, true); next("finished"); }}>やった</button>
              <button type="button" onClick={() => next()}>あとで</button>
              <button type="button" className={`del${armed ? " armed" : ""}`} onClick={async () => {
                if (!armed) { setArmed(true); return; }
                await softDeleteTask(task.id);
                next("removed");
              }}>{armed ? "もう一度で消す" : "消す"}</button>
            </div>
            <p className="triage-count">{index + 1} / {queue.length}件　迷ったら「いつか」でOK</p>
          </>
        ) : (
          <div className="triage-end">
            <strong>片付いた！</strong>
            <p>予定に入れた {done.moved}件・やった {done.finished}件・消した {done.removed}件</p>
            <button type="button" className="button primary" onClick={close}>閉じる</button>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
