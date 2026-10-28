import { useState } from "react";
import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";
import { createTask } from "./store";
import { syncNow } from "./sync";
import type { Task } from "./types";

/**
 * 動き出すための2つ：
 * ・宣言：「◯時までに見せる」を人に言って、その時刻に通知する（期限のない仕事に期限を作る）。
 * ・朝いちばん：その日最初に開いたとき、XやYouTubeの前に「これだけ2分」を出す。
 */
const toast = (text: string) => window.dispatchEvent(new CustomEvent("sasshy-toast", { detail: text }));
const hm = (minute: number) => `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`;
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function PromiseSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const [who, setWho] = useState(() => {
    try { return localStorage.getItem("sasshy-promise-who") || "バイトさん"; } catch { return "バイトさん"; }
  });
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const round = (m: number) => Math.ceil(m / 15) * 15;
  const options = [
    { label: "30分後", minute: round(nowMin + 30) },
    { label: "1時間後", minute: round(nowMin + 60) },
    ...[12, 15, 17].map((h) => ({ label: `${h}時`, minute: h * 60 })).filter((o) => o.minute > nowMin + 20),
  ];
  const save = async (minute: number) => {
    const name = who.trim() || "バイトさん";
    try { localStorage.setItem("sasshy-promise-who", name); } catch { /* なくても動く */ }
    // 決まった時刻の予定として入れると、その時刻にiPhoneが知らせる。
    await createTask({
      title: `約束：「${task.title}」を${name}に見せる`,
      scheduledDate: todayKey(),
      startMinute: minute,
      isFixed: true,
      scheduledStartNotification: true,
      durationMin: 5,
      estimateMin: 5,
      importance: 1,
    });
    syncNow().catch(() => undefined);
    toast(`${hm(minute)}に知らせます。${name}に「${hm(minute)}までに見せるね」と言っておこう`);
    onClose();
  };
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2 promise-sheet" role="dialog" aria-modal="true" aria-label="締め切りを宣言する">
        <header>
          <h2 className="qr-title">締め切りを宣言する</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">
          <p className="promise-what">「{task.title}」</p>
          <p className="settings-hint">期限のない仕事は、人に「◯時までに見せる」と言うと動けます。言う相手と時刻を決めると、その時刻に通知します。</p>
          <label className="promise-who">
            <span>だれに見せる</span>
            <input value={who} onChange={(e) => setWho(e.currentTarget.value)} maxLength={20} />
          </label>
          <div className="promise-times">
            {options.map((o) => (
              <button key={o.label} type="button" onClick={() => save(o.minute)}>
                <strong>{o.label}</strong>
                <small>{hm(o.minute)}まで</small>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** その日はじめて開いたとき（6〜14時）だけ。「あとで」で閉じれば今日はもう出ない。 */
export function shouldShowFirstStep(now = new Date()): boolean {
  const h = now.getHours();
  if (h < 6 || h >= 14) return false;
  try { return localStorage.getItem("sasshy-first-step-day") !== todayKey(); } catch { return false; }
}
export function markFirstStepShown(): void {
  try { localStorage.setItem("sasshy-first-step-day", todayKey()); } catch { /* なくても動く */ }
}

export function FirstStepSheet({ task, onStart, onClose }: { task: Task; onStart: () => void; onClose: () => void }) {
  return createPortal(
    <div className="modal-backdrop first-step" role="presentation">
      <section className="first-step-card" role="dialog" aria-modal="true" aria-label="今日の最初の1つ">
        <span className="first-step-eyebrow">XやYouTubeを開く前に</span>
        <h2>これだけ、2分</h2>
        <p className="first-step-task">{task.title}</p>
        <p className="first-step-hint">手をつけるだけでOK。2分で止めても今日の勝ち。</p>
        <button type="button" className="first-step-go" onClick={() => { markFirstStepShown(); onStart(); onClose(); }}>
          <Play size={18} fill="currentColor" /> 2分だけ始める
        </button>
        <button type="button" className="first-step-later" onClick={() => { markFirstStepShown(); onClose(); }}>あとで</button>
      </section>
    </div>,
    document.body,
  );
}
