import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { useMemos } from "./live";
import { Search, X } from "lucide-react";
import { db } from "./db";
import { searchAll, type Hit, type HitKind } from "./search";
import { RecordEditSheet } from "./RecordEditSheet";
import { openDiaryList } from "./DiaryPanel";
import type { Memo, Task } from "./types";

/** 右上の🔍：タスク・お金・食事・日記・習慣・メモをまとめて探す。 */
const KINDS: { key: HitKind | "all"; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "task", label: "タスク" },
  { key: "money", label: "お金" },
  { key: "meal", label: "食事" },
  { key: "diary", label: "日記" },
  { key: "memo", label: "メモ" },
];
const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;
const md = (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;

export function SearchSheet({ onClose, onEditTask }: { onClose: () => void; onEditTask: (task: Task) => void }) {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) || [];
  const memos = useMemos() || [];
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<HitKind | "all">("all");
  const [record, setRecord] = useState<Memo | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const hits = useMemo(() => searchAll(q, tasks, memos, 200), [q, tasks, memos]);
  const shown = (kind === "all" ? hits : hits.filter((h) => h.kind === kind || (kind === "memo" && h.kind === "habit"))).slice(0, 80);
  const moneyTotal = kind === "money" ? shown.reduce((s, h) => s + (h.memo?.income ? 0 : h.amount || 0), 0) : 0;

  const open = (h: Hit) => {
    if (h.task) { onClose(); onEditTask(h.task); return; }
    if (h.kind === "money" || h.kind === "meal") { setRecord(h.memo!); return; }
    if (h.kind === "diary") { onClose(); openDiaryList(); return; }
    if (h.kind === "habit") {
      onClose();
      window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "records" }));
      window.dispatchEvent(new Event("sasshy-open-habits"));
      return;
    }
    setOpened(opened === h.id ? null : h.id);
  };

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2 search-sheet" role="dialog" aria-modal="true" aria-label="さがす">
        <header>
          <label className="search-box">
            <Search size={17} aria-hidden="true" />
            <input ref={input} type="search" value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="さがす（例：ローソン、マニュアル、3500）" enterKeyHint="search" />
          </label>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="search-kinds" role="tablist" aria-label="種類">
          {KINDS.map((k) => (
            <button key={k.key} type="button" role="tab" aria-selected={kind === k.key} className={kind === k.key ? "active" : ""} onClick={() => setKind(k.key)}>{k.label}</button>
          ))}
        </div>
        <div className="search-results">
          {!q.trim() && <p className="search-empty">言葉や金額を入れると、タスク・お金・食事・日記・メモから探します。</p>}
          {q.trim() && shown.length === 0 && <p className="search-empty">見つかりませんでした</p>}
          {kind === "money" && shown.length > 0 && <p className="search-sum">見つかった支出の合計 <b>{yen(moneyTotal)}</b>（{shown.length}件）</p>}
          <ul>
            {shown.map((h) => (
              <li key={`${h.kind}-${h.id}`}>
                <button type="button" onClick={() => open(h)}>
                  <time>{md(h.date)}</time>
                  <span className={`search-tag ${h.kind}`}>{h.sub}</span>
                  <strong>{h.title}</strong>
                  {h.amount !== null && <b>{yen(h.amount)}</b>}
                </button>
                {opened === h.id && h.memo && <p className="search-body">{h.memo.body || h.memo.title}</p>}
              </li>
            ))}
          </ul>
        </div>
        {record && <RecordEditSheet memo={record} onClose={() => setRecord(null)} />}
      </section>
    </div>,
    document.body,
  );
}
