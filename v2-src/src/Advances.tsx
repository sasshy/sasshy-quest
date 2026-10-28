import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { isAdvance, localDateKey, setAdvanceRepaid } from "./meals";
import { RecordEditSheet } from "./RecordEditSheet";
import { syncNow } from "./sync";
import type { Memo } from "./types";

/**
 * 立て替え中：人の分を払ったもの。自分の支出には数えず、ここで「返ってきた」を押すまで残す。
 */
const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;
const md = (iso: string) => {
  const k = localDateKey(iso);
  return `${Number(k.slice(5, 7))}/${Number(k.slice(8))}`;
};

export function AdvanceCard({ memos }: { memos: Memo[] }) {
  const [showRepaid, setShowRepaid] = useState(false);
  const [editing, setEditing] = useState<Memo | null>(null);
  const all = memos.filter((m) => !m.deletedAt && !m.archived && isAdvance(m)).sort((a, b) => b.expense!.at.localeCompare(a.expense!.at));
  const open = all.filter((m) => !m.expense!.advance?.repaidAt);
  const repaid = all.filter((m) => m.expense!.advance?.repaidAt);
  if (!all.length) return null;
  const total = open.reduce((s, m) => s + Number(m.expense!.amount || 0), 0);
  const byWho = new Map<string, number>();
  for (const m of open) {
    const who = m.expense!.advance?.who || "だれか";
    byWho.set(who, (byWho.get(who) || 0) + Number(m.expense!.amount || 0));
  }
  const mark = async (m: Memo, on: boolean) => {
    await setAdvanceRepaid(m, on);
    syncNow().catch(() => undefined);
  };
  const row = (m: Memo, done: boolean) => (
    <li key={m.id} className={done ? "done" : ""}>
      <button type="button" className="adv-main" onClick={() => setEditing(m)}>
        <strong>{m.expense!.advance?.who || "だれか"}</strong>
        <span>{m.expense!.item}</span>
        <small>{md(m.expense!.at)}{done && m.expense!.advance?.repaidAt ? `・${md(m.expense!.advance.repaidAt)}に返ってきた` : ""}</small>
      </button>
      <b>{yen(Number(m.expense!.amount || 0))}</b>
      <button type="button" className="adv-back" onClick={() => mark(m, !done)}>{done ? "戻す" : "返ってきた"}</button>
    </li>
  );
  return (
    <section className="rec-card adv-card" aria-label="立て替え中">
      <header>
        <h2>立て替え中</h2>
        <strong>{yen(total)}</strong>
      </header>
      {open.length > 0 ? (
        <>
          <p className="adv-sum">{[...byWho.entries()].map(([w, a]) => `${w} ${yen(a)}`).join("・")}</p>
          <ul className="adv-list">{open.map((m) => row(m, false))}</ul>
        </>
      ) : (
        <p className="adv-sum">全部返ってきました</p>
      )}
      {repaid.length > 0 && (
        <button type="button" className="ms-link adv-more" onClick={() => setShowRepaid(!showRepaid)}>
          返ってきた（{repaid.length}）<ChevronDown size={13} className={showRepaid ? "flip" : ""} />
        </button>
      )}
      {showRepaid && <ul className="adv-list">{repaid.map((m) => row(m, true))}</ul>}
      {editing && <RecordEditSheet memo={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
