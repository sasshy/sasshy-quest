import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Trash2, Wallet, X } from "lucide-react";
import { db } from "./db";
import {
  DEFAULT_BUDGET,
  addPlannedSpend,
  budgetStatus,
  getBudget,
  isPlannedMemo,
  markPlannedSpent,
  removePlannedSpend,
  setBudget,
} from "./budget";
import { localDateKey } from "./meals";
import { syncNow } from "./sync";

const yen = (value: number) => `${value < 0 ? "−" : ""}¥${Math.abs(Math.round(value)).toLocaleString("ja-JP")}`;
const md = (key: string) => {
  const d = new Date(`${key}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function useBudget() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const setting = useLiveQuery(async () => {
    await db.settings.get("budget");
    return getBudget();
  }, [], DEFAULT_BUDGET) || DEFAULT_BUDGET;
  const today = localDateKey(Date.now());
  return { memos, setting, status: budgetStatus(memos, setting, today) };
}

/** Today: how much is left to spend today (the reason to open before buying). */
export function BudgetCard() {
  const { setting, status } = useBudget();
  const [open, setOpen] = useState(false);
  if (!setting.enabled) return null;
  const over = status.todayLeft < 0;
  return (
    <>
      <button type="button" className={`budget-card${over ? " over" : ""}`} onClick={() => setOpen(true)}>
        <Wallet size={20} />
        <div>
          <span>{over ? "今日の目安を超えています" : "今日あと使える"}</span>
          <strong>{yen(Math.abs(status.todayLeft))}{over ? " オーバー" : ""}</strong>
        </div>
        <small>
          給料日まで{status.daysLeft}日
          <br />
          残り{yen(status.periodLeft)}
          {status.planned > 0 && `（予定${yen(status.planned)}を除く）`}
        </small>
      </button>
      {open && <BudgetSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function BudgetSheet({ onClose }: { onClose: () => void }) {
  const { memos, setting, status } = useBudget();
  const planned = memos.filter(isPlannedMemo).sort((a, b) => (a.planned!.date || "9").localeCompare(b.planned!.date || "9"));
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [message, setMessage] = useState("");
  const add = async () => {
    try {
      await addPlannedSpend({ item, amount: Number(amount.replace(/[^0-9]/g, "")), date: date || null });
      syncNow().catch(() => undefined);
      setItem("");
      setAmount("");
      setDate("");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-sheet budget-sheet" role="dialog" aria-modal="true" aria-labelledby="budget-title">
        <header>
          <div>
            <span className="eyebrow">BUDGET</span>
            <h2 id="budget-title">使えるお金</h2>
          </div>
          <button type="button" className="icon-button" aria-label="閉じる" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="form-stack">
          <dl className="budget-calc">
            <div><dt>予算（{md(status.start)}〜{md(status.end)}）</dt><dd>{yen(status.budget)}</dd></div>
            <div><dt>これまでに使った</dt><dd>−{yen(status.spentBefore + status.spentToday)}</dd></div>
            <div><dt>使う予定</dt><dd>−{yen(status.planned)}</dd></div>
            <div className="total"><dt>給料日までに使える</dt><dd>{yen(status.periodLeft)}</dd></div>
            <div><dt>1日あたり（残り{status.daysLeft}日）</dt><dd>{yen(status.todayAllowance)}</dd></div>
          </dl>

          <h3 className="budget-h">使う予定のお金</h3>
          <p className="settings-hint">決まっている出費を先に入れておくと、予算から引いて考えます。使ったら ✓ を押すと支出の記録になります。</p>
          {planned.length > 0 && (
            <ul className="budget-planned">
              {planned.map((m) => (
                <li key={m.id}>
                  <span>
                    <strong>{m.planned!.item}</strong>
                    {m.planned!.date && <small>{md(m.planned!.date)}</small>}
                  </span>
                  <b>{yen(m.planned!.amount)}</b>
                  <button type="button" aria-label={`${m.planned!.item}を使った`} onClick={() => markPlannedSpent(m).then(() => syncNow().catch(() => undefined))}>
                    <Check size={16} />
                  </button>
                  <button type="button" aria-label={`${m.planned!.item}を削除`} onClick={() => removePlannedSpend(m.id).then(() => syncNow().catch(() => undefined))}>
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="budget-add"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <input value={item} onChange={(e) => setItem(e.currentTarget.value)} placeholder="例：美容院、飲み会" aria-label="何に" />
            <input value={amount} onChange={(e) => setAmount(e.currentTarget.value)} inputMode="numeric" placeholder="円" aria-label="金額" />
            <input type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} aria-label="日付（任意）" />
            <button className="button primary" type="submit" disabled={!item.trim() || !amount.trim()}>追加</button>
          </form>
          {message && <p className="meal-message">{message}</p>}

          <h3 className="budget-h">設定</h3>
          <label className="budget-setting">
            <span>1か月の予算（生活費・自由に使うお金）</span>
            <input
              inputMode="numeric"
              defaultValue={String(setting.amount)}
              onBlur={(e) => {
                const value = Number(e.currentTarget.value.replace(/[^0-9]/g, ""));
                if (value > 0) setBudget({ amount: value });
              }}
            />
          </label>
          <label className="budget-setting">
            <span>給料日（期間の始まり）</span>
            <select value={setting.startDay} onChange={(e) => setBudget({ startDay: Number(e.currentTarget.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}日</option>
              ))}
            </select>
          </label>
          <button type="button" className="button secondary" onClick={() => setBudget({ enabled: !setting.enabled })}>
            今日の画面に表示：{setting.enabled ? "ON" : "OFF"}
          </button>
        </div>
      </section>
    </div>
  );
}
