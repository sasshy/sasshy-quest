import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { DoorOpen, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { DEFAULT_LEAVE, getLeaveSetting, leaveCountdown, setLeaveSetting } from "./leave";
import { db } from "./db";
import {
  DEFAULT_ROUTINES,
  getRoutines,
  parseRoutineSteps,
  routineStepsText,
  saveRoutines,
  startRoutine,
  type Routine,
} from "./routines";
import { syncNow } from "./sync";
import type { VoiceConfig } from "./types";
import { speakVoice } from "./voice";
import { makeId } from "./db";

/** Today: one tap starts a saved routine (all steps added, first one started). */
export function RoutineBar() {
  const routines = useLiveQuery(async () => {
    await db.settings.get("routines");
    return getRoutines();
  }, [], DEFAULT_ROUTINES) || DEFAULT_ROUTINES;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const start = async (routine: Routine) => {
    if (busy) return;
    setBusy(true);
    try {
      const { tasks } = await startRoutine(routine);
      window.dispatchEvent(new Event("sasshy-open-timer"));
      const voice = (await db.settings.get("voice")) as unknown as VoiceConfig | undefined;
      if (voice?.enabled && tasks[0]) {
        speakVoice(`${routine.name}を始めます。まず${tasks[0].title}、${tasks[0].estimateMin}分`, voice);
      }
      syncNow().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="routine-bar" aria-label="ルーティン">
        <button type="button" className="routine-edit" aria-label="ルーティンを編集" onClick={() => setEditing(true)}>
          <Pencil size={15} />
        </button>
        {routines.map((routine) => (
          <button key={routine.id} type="button" className="routine-chip" disabled={busy} onClick={() => start(routine)}>
            <Play size={14} />
            {routine.name}
            <small>{routine.steps.length}つ・{routine.steps.reduce((sum, step) => sum + step.minutes, 0)}分</small>
          </button>
        ))}
      </section>
      {editing && <RoutineEditor routines={routines} onClose={() => setEditing(false)} />}
    </>
  );
}

function RoutineEditor({ routines, onClose }: { routines: Routine[]; onClose: () => void }) {
  const [drafts, setDrafts] = useState(() =>
    routines.map((routine) => ({ id: routine.id, name: routine.name, text: routineStepsText(routine.steps) })),
  );
  const save = async () => {
    const list = drafts
      .map((draft) => ({ id: draft.id, name: draft.name.trim(), steps: parseRoutineSteps(draft.text) }))
      .filter((routine) => routine.name && routine.steps.length);
    await saveRoutines(list);
    onClose();
  };
  const update = (index: number, changes: Partial<(typeof drafts)[number]>) =>
    setDrafts((list) => list.map((draft, i) => (i === index ? { ...draft, ...changes } : draft)));
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-sheet routine-sheet" role="dialog" aria-modal="true" aria-labelledby="routine-title">
        <header>
          <div>
            <span className="eyebrow">ROUTINE</span>
            <h2 id="routine-title">ルーティンを編集</h2>
          </div>
          <button type="button" className="icon-button" aria-label="閉じる" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="form-stack">
          <p className="settings-hint">1行に1つ、「やること 分」で書きます（例：シャワー 15）。分を省くと5分です。</p>
          {drafts.map((draft, index) => (
            <div key={draft.id} className="routine-draft">
              <div className="routine-draft-head">
                <input
                  value={draft.name}
                  aria-label="ルーティンの名前"
                  onChange={(event) => update(index, { name: event.currentTarget.value })}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${draft.name}を削除`}
                  onClick={() => setDrafts((list) => list.filter((_, i) => i !== index))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <textarea
                rows={Math.max(3, draft.text.split("\n").length + 1)}
                value={draft.text}
                aria-label={`${draft.name}のステップ`}
                onChange={(event) => update(index, { text: event.currentTarget.value })}
              />
            </div>
          ))}
          <LeaveSettingRow />
          <button
            type="button"
            className="button secondary"
            onClick={() => setDrafts((list) => [...list, { id: makeId("routine"), name: "新しいルーティン", text: "" }])}
          >
            <Plus size={16} />
            ルーティンを追加
          </button>
        </div>
        <footer className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            やめる
          </button>
          <button type="button" className="button primary" onClick={save}>
            保存
          </button>
        </footer>
      </section>
    </div>
  );
}

/** Today, from 30 minutes before leaving: countdown + the 退社前 routine. */
export function LeaveBanner() {
  const setting = useLiveQuery(async () => {
    await db.settings.get("leaveTime");
    return getLeaveSetting();
  }, [], DEFAULT_LEAVE) || DEFAULT_LEAVE;
  const routines = useLiveQuery(() => getRoutines(), [], DEFAULT_ROUTINES) || DEFAULT_ROUTINES;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const left = leaveCountdown(setting, now);
  if (left === null) return null;
  const routine = routines.find((r) => r.id === "leave-work") || routines.find((r) => r.name.includes("退社"));
  const hhmm = `${Math.floor(setting.minute / 60)}:${String(setting.minute % 60).padStart(2, "0")}`;
  const start = async () => {
    if (!routine) return;
    await startRoutine(routine);
    window.dispatchEvent(new Event("sasshy-open-timer"));
    syncNow().catch(() => undefined);
  };
  return (
    <section className={`leave-banner${left < 0 ? " late" : ""}`} aria-label="退社">
      <DoorOpen size={22} />
      <div>
        <strong>{left > 0 ? `退社 ${hhmm} まであと${left}分` : left === 0 ? `退社 ${hhmm} です` : `退社（${hhmm}）を${-left}分過ぎた`}</strong>
        <small>新しい作業は足さず、出る準備へ</small>
      </div>
      {routine && (
        <button type="button" onClick={start}>
          <Play size={15} />
          {routine.name}
        </button>
      )}
    </section>
  );
}

function LeaveSettingRow() {
  const setting = useLiveQuery(async () => {
    await db.settings.get("leaveTime");
    return getLeaveSetting();
  }, [], DEFAULT_LEAVE) || DEFAULT_LEAVE;
  const value = `${String(Math.floor(setting.minute / 60)).padStart(2, "0")}:${String(setting.minute % 60).padStart(2, "0")}`;
  return (
    <div className="leave-setting">
      <DoorOpen size={16} />
      <span>平日の退社時刻</span>
      <input
        type="time"
        value={value}
        onChange={(event) => {
          const [h, m] = event.currentTarget.value.split(":").map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) setLeaveSetting({ minute: h * 60 + m });
        }}
      />
      <button type="button" className="button secondary" onClick={() => setLeaveSetting({ enabled: !setting.enabled })}>
        30分前のお知らせ：{setting.enabled ? "ON" : "OFF"}
      </button>
    </div>
  );
}
