import { useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, ListChecks, NotebookPen, Utensils, Wallet, X } from "lucide-react";
import { db } from "./db";
import { MealSheet } from "./MealPanel";
import { DiaryEditor, openDiaryList } from "./DiaryPanel";
import { diaryOn } from "./diary";
import { countIn, habits, setHabitDay } from "./habits";
import { expensesOn, localDateKey, mealsOn, walletOn } from "./meals";
import { syncNow } from "./sync";
import { haptic } from "./feedback";

type Sheet = "meal" | "expense" | "habit" | "diary" | null;

/** Today: one row of four — 食事・支出・習慣・日記 — with what is already recorded today. */
export function QuickRecord() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const [sheet, setSheet] = useState<Sheet>(null);
  const today = localDateKey(Date.now());
  const meals = mealsOn(memos, today).length;
  const spends = expensesOn(memos, today).length;
  const list = habits(memos);
  const habitsDone = list.filter((h) => h.habit!.days.includes(today)).length;
  const diary = diaryOn(memos, today);
  const yen = walletOn(memos, today);

  const items = [
    { key: "meal" as const, icon: <Utensils size={20} />, label: "食事", note: meals ? `${meals}回` : "まだ", done: meals > 0 },
    { key: "expense" as const, icon: <Wallet size={20} />, label: "支出", note: yen ? `¥${yen.toLocaleString("ja-JP")}` : spends ? `${spends}件` : "まだ", done: yen > 0 || spends > 0 },
    { key: "habit" as const, icon: <ListChecks size={20} />, label: "習慣", note: list.length ? `${habitsDone}/${list.length}` : "足す", done: list.length > 0 && habitsDone === list.length },
    { key: "diary" as const, icon: <NotebookPen size={20} />, label: "日記", note: diary ? "書いた" : "まだ", done: Boolean(diary) },
  ];

  return (
    <>
      <section className="qr" aria-label="記録する">
        {items.map((it) => (
          <button key={it.key} type="button" className={`qr-btn${it.done ? " done" : ""}`} onClick={() => setSheet(it.key)}>
            <span className="qr-icon">{it.icon}</span>
            <strong>{it.label}</strong>
            <small>{it.note}</small>
          </button>
        ))}
      </section>
      {(sheet === "meal" || sheet === "expense") && createPortal(<MealSheet initialTab={sheet} onClose={() => setSheet(null)} />, document.body)}
      {sheet === "habit" && <HabitSheet onClose={() => setSheet(null)} />}
      {sheet === "diary" && <DiarySheet onClose={() => setSheet(null)} />}
    </>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2 className="qr-title">{title}</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="form-stack">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function HabitSheet({ onClose }: { onClose: () => void }) {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const today = localDateKey(Date.now());
  const list = habits(memos);
  return (
    <Sheet title="今日の習慣" onClose={onClose}>
      {list.length === 0 && <p className="hb-empty">まだ習慣がありません。「記録」タブの「習慣」から足せます。</p>}
      <div className="hb-checks">
        {list.map((h) => {
          const done = h.habit!.days.includes(today);
          return (
            <button key={h.id} type="button" className={`hb-check${done ? " done" : ""}`} aria-pressed={done} onClick={async () => {
              if (!done) haptic("success");
              await setHabitDay(h, today, !done);
              syncNow().catch(() => undefined);
            }}>
              <span className="hb-box">{done && <Check size={18} strokeWidth={3} />}</span>
              <span className="hb-name">{h.habit!.name}</span>
              <small>今月{countIn(h, today.slice(0, 7))}回</small>
            </button>
          );
        })}
      </div>
      <button type="button" className="ms-link" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "records" })); window.dispatchEvent(new Event("sasshy-open-habits")); }}>
        カレンダーで見る・習慣を足す ›
      </button>
    </Sheet>
  );
}

function DiarySheet({ onClose }: { onClose: () => void }) {
  const today = localDateKey(Date.now());
  return (
    <Sheet title="ひとこと日記" onClose={onClose}>
      <DiaryEditor date={today} />
      <button type="button" className="ms-link" onClick={() => { onClose(); openDiaryList(); }}>これまでの日記 ›</button>
    </Sheet>
  );
}
