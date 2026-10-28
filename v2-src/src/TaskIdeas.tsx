import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { getSyncConfig, syncNow } from "./sync";
import { updateTask } from "./store";
import type { Task } from "./types";

/**
 * 後回しのタスクを、好きなこと（AI・アプリ作りなど）につなげた「やってみたくなるやり方」に
 * AIが言い換える。3案から選ぶと、タスク名・最初の1手（ゴール）・時間が置き換わる（元の名前はメモに残す）。
 */
export interface TaskIdea { title: string; first: string; why: string; minutes: number }
const LIKES_KEY = "sasshy-likes";
const DEFAULT_LIKES = "AIを使うこと、アプリ作り、仕組み化、ガジェット";

async function fetchIdeas(task: Task, likes: string): Promise<TaskIdea[]> {
  const config = await getSyncConfig();
  if (!config.url || !config.apiKey || !config.syncKey) throw new Error("同期設定が必要です（設定 › 同期）");
  const key = config.apiKey.trim();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${config.url.trim().replace(/\/+$/, "")}/functions/v1/sasshy-task-ideas`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ syncKey: config.syncKey, title: task.title, notes: task.notes, likes }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as { ideas?: TaskIdea[]; error?: string };
    if (!response.ok || !payload.ideas?.length) throw new Error(payload.error || "AIに考えてもらえませんでした");
    return payload.ideas;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("時間がかかりすぎました。もう一度押してください");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

/** タスクを、最初の一手から終わりまでの小さな手順（3〜7個・分つき）にしてもらう。 */
export async function fetchTaskSteps(task: Task): Promise<{ title: string; minutes: number }[]> {
  const config = await getSyncConfig();
  if (!config.url || !config.apiKey || !config.syncKey) throw new Error("同期設定が必要です（設定 › 同期）");
  const key = config.apiKey.trim();
  const response = await fetch(`${config.url.trim().replace(/\/+$/, "")}/functions/v1/sasshy-task-ideas`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ syncKey: config.syncKey, title: task.title, notes: task.notes, mode: "steps" }),
  });
  const payload = await response.json().catch(() => ({})) as { steps?: { title: string; minutes: number }[]; error?: string };
  if (!response.ok || !payload.steps?.length) throw new Error(payload.error || "手順を作れませんでした");
  return payload.steps;
}

export function TaskIdeasSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const [likes, setLikes] = useState(() => {
    try { return localStorage.getItem(LIKES_KEY) || DEFAULT_LIKES; } catch { return DEFAULT_LIKES; }
  });
  const [ideas, setIdeas] = useState<TaskIdea[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      try { localStorage.setItem(LIKES_KEY, likes.trim() || DEFAULT_LIKES); } catch { /* なくても動く */ }
      setIdeas(await fetchIdeas(task, likes));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async (idea: TaskIdea) => {
    const notes = [`元のタスク：${task.title}`, `なぜ楽しい：${idea.why}`, task.notes].filter(Boolean).join("\n");
    await updateTask(task.id, { title: idea.title, doneWhen: idea.first, estimateMin: idea.minutes, durationMin: idea.minutes, notes }, "好きなやり方にする");
    syncNow().catch(() => undefined);
    window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: `「${idea.title}」にしました（元の名前はメモに残しています）` }));
    onClose();
  };
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2 ideas-sheet" role="dialog" aria-modal="true" aria-label="好きなやり方にする">
        <header>
          <h2 className="qr-title"><Sparkles size={18} /> 好きなやり方にする</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">
          <p className="ideas-task">「{task.title}」</p>
          {busy && <p className="ideas-wait">考えています…</p>}
          {error && <p className="ml-note">{error}</p>}
          {ideas && (
            <ul className="ideas-list">
              {ideas.map((idea) => (
                <li key={idea.title}>
                  <button type="button" onClick={() => pick(idea)}>
                    <strong>{idea.title}</strong>
                    <span>最初の一手：{idea.first}</span>
                    <small>{idea.why}・{idea.minutes}分</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="ideas-likes">
            <span>好きなこと（変えると次から反映）</span>
            <input value={likes} onChange={(e) => setLikes(e.currentTarget.value)} maxLength={120} />
          </label>
          <button type="button" className="button secondary" disabled={busy} onClick={run}>ほかの案を出す</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
