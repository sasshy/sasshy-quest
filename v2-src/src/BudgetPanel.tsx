import { useEffect, useRef, useState } from "react";
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
  shoppingStatus,
} from "./budget";
import { localDateKey } from "./meals";
import { isIncomeMemo } from "./money";
import { syncNow } from "./sync";

const yen = (value: number) => `${value < 0 ? "−" : ""}¥${Math.abs(Math.round(value)).toLocaleString("ja-JP")}`;
const md = (key: string) => {
  const d = new Date(`${key}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export function useBudget() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const setting = useLiveQuery(async () => {
    await db.settings.get("budget");
    return getBudget();
  }, [], DEFAULT_BUDGET) || DEFAULT_BUDGET;
  const today = localDateKey(Date.now());
  return { memos, setting, status: budgetStatus(memos, setting, today), shopping: shoppingStatus(memos, setting, today) };
}

/** Counts to the new value (e.g. after recording a spend), so the change is felt. */
export function useCountTo(target: number): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 700);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(start + (target - start) * eased));
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

/** Today: how much is left to spend today (the reason to open before buying). */
export function BudgetCard() {
  const { setting, status, shopping } = useBudget();
  const [open, setOpen] = useState(false);
  // フックは必ず毎回同じ順で呼ぶ（表示OFFで先に return すると画面ごと落ちる）。
  const shown = useCountTo(status.todayLeft);
  if (!setting.enabled) return null;
  const over = status.todayLeft < 0;
  return (
    <>
      <button type="button" className={`budget-card${over ? " over" : ""}`} onClick={() => setOpen(true)}>
        <Wallet size={20} />
        <div>
          <span>{over ? "今日の目安を超えています" : "今日あと使える"}</span>
          <strong>{yen(Math.abs(shown))}{over ? " オーバー" : ""}</strong>
          <em className={`budget-shop${shopping.left < 0 ? " over" : ""}`}>買い物枠 あと{yen(shopping.left)}</em>
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
  const { memos, setting, status, shopping } = useBudget();
  // この期間に記録した手取り。なければ設定の見込み額。
  const incomeRecordedSum = memos
    .filter((m) => isIncomeMemo(m) && localDateKey(m.income!.at) >= status.start && localDateKey(m.income!.at) <= status.end)
    .reduce((sum, m) => sum + Number(m.income!.amount || 0), 0);
  const incomeRecorded = incomeRecordedSum > 0;
  const income = incomeRecorded ? incomeRecordedSum : setting.incomeMonthly || 0;
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
          {/* 今日の目安の出し方を、そのままの式で見せる。 */}
          <section className="bc-card" aria-label="今日の目安の計算">
            <h3 className="budget-h">今日の目安の出し方</h3>
            <div className="bc-row"><span>毎日のお金（{md(status.start)}〜{md(status.end)}）</span><b>{yen(status.budget)}</b></div>
            <div className="bc-row minus"><span>昨日までに使った</span><b>−{yen(status.spentBefore)}</b></div>
            {status.planned > 0 && <div className="bc-row minus"><span>使う予定のお金</span><b>−{yen(status.planned)}</b></div>}
            <div className="bc-row sub"><span>今日から使える</span><b>{yen(status.remaining)}</b></div>
            <div className="bc-row minus"><span>÷ 給料日までの日数（今日を入れて）</span><b>{status.daysLeft}日</b></div>
            <div className="bc-row total"><span>今日の目安</span><b>{yen(status.todayAllowance)}</b></div>
            <div className="bc-row minus"><span>今日使った</span><b>−{yen(status.spentToday)}</b></div>
            <div className={`bc-row total${status.todayLeft < 0 ? " over" : ""}`}><span>{status.todayLeft < 0 ? "今日オーバー" : "今日あと使える"}</span><b>{yen(Math.abs(status.todayLeft))}</b></div>
            <p className="settings-hint">昨日までに使いすぎると、残りを残りの日数で割り直すので次の日から目安が下がります。節約すると上がります。買い物枠と病院などの「予算の外」はここに入りません。</p>
          </section>

          {income > 0 && (
            <section className="bc-card" aria-label="手取りの分け方">
              <h3 className="budget-h">手取りの分け方</h3>
              <div className="bc-row"><span>手取り{incomeRecorded ? "" : "（見込み）"}</span><b>{yen(income)}</b></div>
              <div className="bc-row minus"><span>毎日のお金</span><b>−{yen(status.budget)}</b></div>
              <div className="bc-row minus"><span>買い物枠</span><b>−{yen(shopping.budget)}</b></div>
              <div className={`bc-row total${income - status.budget - shopping.budget < 0 ? " over" : ""}`}><span>それ以外（家賃・固定費・貯金など）</span><b>{yen(income - status.budget - shopping.budget)}</b></div>
              <p className="settings-hint">手取りは目安の計算には直接使いません。目安を変えたいときは、下の「毎日のお金」の金額を変えます。</p>
            </section>
          )}

          <dl className="budget-calc">
            <div><dt>買い物枠（ドラッグストア・Amazonなど）</dt><dd>{yen(shopping.budget)}</dd></div>
            <div><dt>これまでに使った</dt><dd>−{yen(shopping.spent)}</dd></div>
            <div className="total"><dt>給料日までの残り</dt><dd>{yen(shopping.left)}</dd></div>
          </dl>
          <p className="settings-hint">Amazon・楽天・ドラッグストアなどは買い物枠、病院・調剤薬局は「予算の外」に自動で入ります（どちらも毎日の「あと使える」は減りません）。記録を押すと変えられます。</p>

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
            <span>毎日のお金（1か月：お昼・間食・コンビニなど）</span>
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
            <span>買い物枠（1か月：ドラッグストア・Amazonなど）</span>
            <input
              inputMode="numeric"
              defaultValue={String(setting.shoppingAmount ?? 20000)}
              onBlur={(e) => {
                const value = Number(e.currentTarget.value.replace(/[^0-9]/g, ""));
                if (value >= 0) setBudget({ shoppingAmount: value });
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
          {/* 押し間違えで消えないよう、ボタンではなくチェックで切り替える。 */}
          <label className="toggle-row">
            <span>
              <strong>今日の画面に「今日あと使える」を出す</strong>
              <small>外すと今日の画面から消えます（記録 › お金 からいつでも戻せます）</small>
            </span>
            <input type="checkbox" checked={setting.enabled} onChange={(e) => setBudget({ enabled: e.currentTarget.checked })} />
          </label>
        </div>
      </section>
    </div>
  );
}
