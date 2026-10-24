import { useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import { MEAL_LABEL, PAYMENT_LABEL, removeMeal, updateExpense, updateMeal } from "./meals";
import { syncNow } from "./sync";
import type { MealKind, MealPayment, Memo } from "./types";

const KINDS: MealKind[] = ["breakfast", "lunch", "dinner", "snack"];
const PAYMENTS: MealPayment[] = ["self", "treated", "split", "paid_for_others"];

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const toYen = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[^0-9]/g, "")));

/** Tap a meal / spend row → fix any field, or delete it (recoverable from history). */
export function RecordEditSheet({ memo, onClose }: { memo: Memo; onClose: () => void }) {
  const meal = memo.meal;
  const expense = memo.expense;
  const [kind, setKind] = useState<MealKind>(meal?.kind || "snack");
  const [payment, setPayment] = useState<MealPayment>(meal?.payment || "self");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (form: FormData) => {
    setBusy(true);
    setError("");
    try {
      const whenText = String(form.get("when") || "");
      const at = whenText ? new Date(whenText).toISOString() : (meal?.at || expense!.at);
      if (meal) {
        await updateMeal(memo.id, {
          kind,
          item: String(form.get("item") || ""),
          price: toYen(String(form.get("price") || "")),
          at,
          place: String(form.get("place") || "") || null,
          payment,
          paid: toYen(String(form.get("paid") || "")),
        });
      } else {
        await updateExpense(memo.id, { item: String(form.get("item") || ""), amount: toYen(String(form.get("price") || "")), at });
      }
      syncNow().catch(() => undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-sheet ms2 record-edit" role="dialog" aria-modal="true" aria-labelledby="record-edit-title">
        <header>
          <h2 id="record-edit-title">{meal ? "食事の記録を直す" : "支出の記録を直す"}</h2>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}><X size={20} /></button>
        </header>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); submit(new FormData(event.currentTarget)); }}>
          {meal && (
            <div className="ms-kinds" role="group" aria-label="いつの食事">
              {KINDS.map((value) => (
                <button key={value} type="button" className={kind === value ? "active" : ""} onClick={() => setKind(value)}>{MEAL_LABEL[value]}</button>
              ))}
            </div>
          )}
          <label className="re-field">
            <span>{meal ? "食べたもの" : "何に使った"}</span>
            <input name="item" defaultValue={meal?.item || expense?.item || ""} className="ms-item" />
          </label>
          <div className="re-two">
            <label className="re-field">
              <span>金額</span>
              <input name="price" inputMode="numeric" defaultValue={meal ? meal.price ?? "" : expense?.amount ?? ""} placeholder={meal ? "家なら空欄" : "円"} />
            </label>
            <label className="re-field">
              <span>日時</span>
              <input name="when" type="datetime-local" defaultValue={toLocalInput(meal?.at || expense!.at)} />
            </label>
          </div>
          {meal && (
            <>
              <label className="re-field">
                <span>どこで</span>
                <input name="place" defaultValue={meal.place || ""} placeholder="家・会社・店名" maxLength={60} />
              </label>
              <div className="ms-chips" role="group" aria-label="支払い">
                {PAYMENTS.map((p) => (
                  <button key={p} type="button" className={`ms-chip${payment === p ? " picked" : ""}`} onClick={() => setPayment(p)}>
                    <span>{PAYMENT_LABEL[p]}</span>
                  </button>
                ))}
              </div>
              {(payment === "split" || payment === "paid_for_others") && (
                <label className="re-field">
                  <span>実際に払った額</span>
                  <input name="paid" inputMode="numeric" defaultValue={meal.paid ?? ""} placeholder="円" />
                </label>
              )}
            </>
          )}
          {error && <p className="re-error" role="alert">{error}</p>}
          <button className="button primary re-save" type="submit" disabled={busy}>保存</button>
          <button
            type="button"
            className="re-delete"
            onClick={async () => { await removeMeal(memo.id); syncNow().catch(() => undefined); onClose(); }}
          >
            <Trash2 size={15} /> この記録を消す（復元から戻せます）
          </button>
        </form>
      </section>
    </div>,
    document.body,
  );
}
