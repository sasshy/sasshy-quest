import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Bell, BellOff, ChevronLeft, ChevronRight, ClipboardCopy, ClipboardPaste, Home, Sparkles, Trash2, Utensils, Wallet, X } from "lucide-react";
import { db } from "./db";
import {
  DEFAULT_MEAL_REMINDER,
  MEAL_AI_PROMPT,
  MEAL_LABEL,
  PAYMENT_LABEL,
  paidAmount,
  valueOn,
  type MealInput,
  getMealReminder,
  kcalOn,
  localDateKey,
  parseMealPaste,
  recentPlaces,
  mealFavorites,
  mealsOn,
  expensesOn,
  ledgerOn,
  recordExpense,
  shiftDateKey,
  walletOn,
  recordMeal,
  recordMeals,
  removeMeal,
  setMealReminder,
  spendOn,
  suggestKind,
} from "./meals";
import { syncNow } from "./sync";
import type { AppSetting, MealKind, MealPayment } from "./types";

const KINDS: MealKind[] = ["breakfast", "lunch", "dinner", "snack"];
const PAYMENTS: MealPayment[] = ["self", "treated", "split", "paid_for_others"];
const yen = (value: number) => `¥${value.toLocaleString("ja-JP")}`;
const kcalText = (value: number) => `${value.toLocaleString("ja-JP")}kcal`;

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Copy text; falls back to a hidden textarea where navigator.clipboard is unavailable (iPhone app). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Today strip: what was eaten today and a one-tap entry to record. */
export function MealQuickBar() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const [open, setOpen] = useState(false);
  const today = localDateKey(Date.now());
  const meals = mealsOn(memos, today);
  const expenses = expensesOn(memos, today);
  const spend = walletOn(memos, today);
  const kcal = kcalOn(memos, today);
  const value = valueOn(memos, today);
  return (
    <>
      <section className="meal-strip" aria-label="今日の食事・間食">
        <button className="meal-strip-button" type="button" onClick={() => setOpen(true)}>
          <Utensils size={18} />
          <span>食事・支出を記録</span>
        </button>
        <div className="meal-strip-summary">
          {meals.length === 0 && expenses.length === 0 ? (
            <small>今日はまだ記録なし</small>
          ) : (
            <>
              <strong>
                {yen(spend)}
                {value !== spendOn(memos, today) && <small className="meal-value">（食事の値段{yen(value)}）</small>}
                {kcal > 0 && ` ・ ${kcalText(kcal)}`}
              </strong>
              <small>
                {KINDS.map((k) => {
                  const items = meals.filter((m) => m.meal!.kind === k).map((m) => m.meal!.item);
                  return items.length ? `${MEAL_LABEL[k]} ${items.join("・")}` : "";
                })
                  .concat(expenses.length ? [`支出 ${expenses.map((m) => m.expense!.item).join("・")}`] : [])
                  .filter(Boolean)
                  .join(" ／ ")}
              </small>
            </>
          )}
        </div>
        <button
          className="meal-strip-more"
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("sasshy-open-page", { detail: "records" }))}
        >
          記録を見る
        </button>
      </section>
      {open && createPortal(<MealSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function MealSheet({ onClose }: { onClose: () => void }) {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const reminder = useLiveQuery(() => getMealReminder(), [], DEFAULT_MEAL_REMINDER) || DEFAULT_MEAL_REMINDER;
  const [kind, setKind] = useState<MealKind>(() => suggestKind());
  const [when, setWhen] = useState(""); // datetime-local value; empty = now
  const [place, setPlace] = useState("");
  const [payment, setPayment] = useState<MealPayment>("self");
  const [paidText, setPaidText] = useState("");
  const atIso = () => (when ? new Date(when).toISOString() : undefined);
  const places = recentPlaces(memos);
  const [item, setItem] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"meal" | "expense">("meal");
  const favorites = mealFavorites(memos, Date.now(), 10, { kind, minCount: 2, maxLength: 24 });
  const hidden = (useLiveQuery(() => db.settings.get("mealFavHidden"), [], undefined) as unknown as { items?: string[] } | undefined)?.items || [];
  const setHidden = (items: string[]) => db.settings.put({ id: "mealFavHidden", items } as unknown as AppSetting);
  const hideFavorite = (name: string) => setHidden([...hidden, name]);
  const [editingFavs, setEditingFavs] = useState(false);
  const recentExpenseItems = [...new Set(memos
    .filter((m) => !m.deletedAt && m.expense && Date.parse(m.expense.at) > Date.now() - 60 * 86_400_000)
    .sort((a, b) => Date.parse(b.expense!.at) - Date.parse(a.expense!.at))
    .map((m) => m.expense!.item.trim()))].slice(0, 6);
  const today = localDateKey(Date.now());
  // 過去の日も見返せるように、表示する日を切り替えられる。
  const [viewDate, setViewDate] = useState(today);
  const dayRecords = ledgerOn(memos, viewDate);
  const [expenseItem, setExpenseItem] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const viewLabel = viewDate === today
    ? "今日"
    : viewDate === shiftDateKey(today, -1)
      ? "昨日"
      : new Date(`${viewDate}T12:00:00`).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });
  const saveExpense = async (typedItem = expenseItem, typedAmount = expenseAmount) => {
    setBusy(true);
    try {
      const amount = typedAmount.trim() === "" ? null : Number(typedAmount.replace(/[^0-9]/g, ""));
      await recordExpense({ item: typedItem, amount, at: atIso() });
      syncNow().catch(() => undefined);
      setMessage(`支出「${typedItem.trim()}」を記録しました`);
      setExpenseItem("");
      setExpenseAmount("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "記録できませんでした");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 2500);
    return () => window.clearTimeout(timer);
  }, [message]);

  const [aiOpen, setAiOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [drafts, setDrafts] = useState<(MealInput & { use: boolean })[]>([]);

  const copyPrompt = async () => {
    const ok = await copyText(MEAL_AI_PROMPT);
    setMessage(ok ? "質問文をコピーしました。ChatGPTかClaudeに写真と一緒に貼ってください" : "コピーできませんでした。下の質問文を長押ししてコピーしてください");
  };

  const readPasted = () => {
    const items = parseMealPaste(pasted, kind);
    setDrafts(items.map((item) => ({ ...item, use: true })));
    if (!items.length) setMessage("読み取れませんでした。AIの返事をそのまま貼ってください");
  };

  const saveDrafts = async () => {
    const chosen = drafts.filter((d) => d.use && d.item.trim()).map(({ use: _use, ...rest }) => rest);
    if (!chosen.length) return;
    setBusy(true);
    try {
      const at = atIso();
      await recordMeals(chosen.map((d) => ({ ...d, place: d.place || place.trim() || null, payment: d.payment ?? payment })), at ? Date.parse(at) : Date.now());
      syncNow().catch(() => undefined);
      setDrafts([]);
      setPasted("");
      setAiOpen(false);
      setMessage(`${chosen.length}品を記録しました`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "記録できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const updateDraft = (index: number, changes: Partial<MealInput & { use: boolean }>) =>
    setDrafts((list) => list.map((d, i) => (i === index ? { ...d, ...changes } : d)));

  const save = async (input: MealInput, closeAfter: boolean) => {
    setBusy(true);
    try {
      await recordMeal({ ...input, at: input.at ?? atIso(), place: input.place ?? (place.trim() || null), payment: input.payment ?? payment });
      syncNow().catch(() => undefined);
      setItem("");
      setPrice("");
      setPaidText("");
      setPayment("self");
      setMessage(`${MEAL_LABEL[input.kind]}「${input.item}」を記録しました`);
      if (closeAfter) window.setTimeout(onClose, 600);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "記録できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const priceValue = price.trim() === "" ? null : Number(price.replace(/[^0-9]/g, ""));

  const detailSummary = [
    when ? new Date(when).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "今",
    place.trim() || "場所なし",
    PAYMENT_LABEL[payment],
  ].join("・");
  const showHome = kind === "breakfast" || kind === "dinner";
  const visibleFavorites = favorites.filter((fav) => !hidden.includes(fav.item) && !(showHome && fav.item === "家ごはん"));

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-sheet meal-sheet ms2" role="dialog" aria-modal="true" aria-labelledby="meal-title">
        <header>
          <div className="ms-tabs" role="tablist" aria-label="記録する種類">
            <h2 id="meal-title" className="sr-only">食事・支出を記録</h2>
            <button type="button" role="tab" aria-selected={tab === "meal"} className={tab === "meal" ? "active" : ""} onClick={() => setTab("meal")}>
              <Utensils size={15} /> 食事
            </button>
            <button type="button" role="tab" aria-selected={tab === "expense"} className={tab === "expense" ? "active" : ""} onClick={() => setTab("expense")}>
              <Wallet size={15} /> 支出
            </button>
          </div>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="form-stack">
          {tab === "meal" ? (
            <>
              <div className="ms-kinds" role="group" aria-label="いつの食事">
                {KINDS.map((value) => (
                  <button key={value} type="button" className={kind === value ? "active" : ""} onClick={() => setKind(value)}>
                    {MEAL_LABEL[value]}
                  </button>
                ))}
              </div>

              <form
                className="ms-entry"
                onSubmit={(event) => {
                  event.preventDefault();
                  // iPhoneの日本語入力は、変換中の文字がまだstateに入っていないことがある。
                  // 押した瞬間の入力欄の中身を直接読む。
                  const form = new FormData(event.currentTarget);
                  const typedItem = String(form.get("item") || "");
                  const typedPrice = String(form.get("price") || "");
                  const typedPaid = String(form.get("paid") || "");
                  const toYen = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[^0-9]/g, "")));
                  save({ kind, item: typedItem, price: toYen(typedPrice), paid: toYen(typedPaid) }, false);
                }}
              >
                <input
                  name="item"
                  className="ms-item"
                  value={item}
                  onChange={(event) => setItem(event.target.value)}
                  placeholder={kind === "dinner" ? "何を食べた？（例：カレー）" : "何を食べた？（例：鮭おにぎり）"}
                  aria-label="食べたもの"
                  enterKeyHint="done"
                />
                <div className="ms-entry-row">
                  <label className="ms-yen">
                    <span>¥</span>
                    <input name="price" value={price} onChange={(event) => setPrice(event.target.value)} inputMode="numeric" placeholder="金額（家なら空欄）" aria-label="金額" />
                  </label>
                  <button className="button primary" type="submit" disabled={busy}>記録</button>
                </div>
                {(payment === "split" || payment === "paid_for_others") && (
                  <label className="ms-yen">
                    <span>払った</span>
                    <input name="paid" value={paidText} onChange={(event) => setPaidText(event.target.value)} inputMode="numeric" placeholder="実際に払った額" aria-label="実際に払った額" />
                  </label>
                )}
              </form>

              <div className="ms-favs">
                <div className="ms-favs-head">
                  <span>ワンタップで記録</span>
                  {visibleFavorites.length > 0 && (
                    <button type="button" onClick={() => setEditingFavs((v) => !v)}>{editingFavs ? "完了" : "整理"}</button>
                  )}
                </div>
                <div className="ms-chips">
                  {showHome && !editingFavs && (
                    <button type="button" className="ms-chip home" disabled={busy} onClick={() => save({ kind, item: "家ごはん", price: null, place: place.trim() || "家" }, false)}>
                      <Home size={14} />
                      <span>家ごはん</span>
                    </button>
                  )}
                  {visibleFavorites.map((fav) => (
                    <button
                      key={fav.item}
                      type="button"
                      className={`ms-chip${editingFavs ? " editing" : ""}`}
                      disabled={busy}
                      title={fav.item}
                      onClick={() =>
                        editingFavs
                          ? hideFavorite(fav.item)
                          : save({ kind, item: fav.item, price: fav.price, kcal: fav.kcal, protein: fav.protein, fat: fav.fat, carbs: fav.carbs, place: place.trim() || fav.place || null }, false)
                      }
                    >
                      <span>{fav.item}</span>
                      {editingFavs ? <X size={13} /> : fav.price !== null && <small>¥{fav.price.toLocaleString("ja-JP")}</small>}
                    </button>
                  ))}
                  {!showHome && visibleFavorites.length === 0 && <small className="ms-hint">2回以上食べたものがここに並びます</small>}
                </div>
                {editingFavs && hidden.length > 0 && (
                  <button type="button" className="ms-link" onClick={() => setHidden([])}>隠したもの（{hidden.length}）を戻す</button>
                )}
              </div>

              <details className="ms-more">
                <summary>
                  <span>いつ・どこ・支払い</span>
                  <small>{detailSummary}</small>
                </summary>
                <div className="meal-when-where">
                  <label>
                    <span>いつ</span>
                    <input
                      type="datetime-local"
                      value={when}
                      max={toLocalInput(new Date())}
                      onChange={(event) => {
                        setWhen(event.target.value);
                        if (event.target.value) setKind(suggestKind(new Date(event.target.value)));
                      }}
                    />
                    {when ? (
                      <button type="button" className="meal-chip" onClick={() => { setWhen(""); setKind(suggestKind()); }}>今に戻す</button>
                    ) : (
                      <button type="button" className="meal-chip" onClick={() => { const d = new Date(Date.now() - 86_400_000); d.setHours(12, 0, 0, 0); setWhen(toLocalInput(d)); setKind(suggestKind(d)); }}>昨日</button>
                    )}
                  </label>
                  <label>
                    <span>どこで</span>
                    <input value={place} onChange={(event) => setPlace(event.target.value)} placeholder="家・会社・店名" maxLength={60} />
                  </label>
                  <div className="meal-places">
                    {places.map((p) => (
                      <button key={p} type="button" className={`meal-chip${place === p ? " active" : ""}`} onClick={() => setPlace(place === p ? "" : p)}>
                        {p}
                      </button>
                    ))}
                  </div>
                  <label className="meal-payment">
                    <span>支払い</span>
                    <select value={payment} onChange={(event) => setPayment(event.target.value as MealPayment)}>
                      {PAYMENTS.map((p) => (
                        <option key={p} value={p}>{PAYMENT_LABEL[p]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>

              <div className="meal-ai ms-more">
                <button type="button" className="meal-ai-toggle" onClick={() => setAiOpen((v) => !v)} aria-expanded={aiOpen}>
                  <Sparkles size={16} />
                  <span>
                    <strong>写真・レシートからAIで記録</strong>
                    <small>ChatGPT・Claudeの返事を貼るだけ。何品でもまとめて</small>
                  </span>
                </button>
                {aiOpen && (
                  <div className="meal-ai-body">
                    <ol className="meal-ai-steps">
                      <li>
                        <button type="button" className="button secondary" onClick={copyPrompt}>
                          <ClipboardCopy size={16} />
                          質問文をコピー
                        </button>
                      </li>
                      <li>ChatGPTかClaudeに、料理かレシートの写真（または「コンビニで鮭おにぎりと唐揚げ」などのメモ）と一緒に貼って送る</li>
                      <li>返ってきた答えをコピーして、下に貼る</li>
                    </ol>
                    <details className="meal-ai-prompt">
                      <summary>質問文を見る</summary>
                      <pre>{MEAL_AI_PROMPT}</pre>
                    </details>
                    <textarea
                      value={pasted}
                      onChange={(event) => setPasted(event.target.value)}
                      placeholder={"ここにAIの返事を貼り付け\n例：昼食|鮭おにぎり|160|180|5|2|38|レシート"}
                      rows={4}
                    />
                    <button type="button" className="button secondary" onClick={readPasted} disabled={!pasted.trim()}>
                      <ClipboardPaste size={16} />
                      読み取る
                    </button>
                    {drafts.length > 0 && (
                      <div className="meal-drafts">
                        <span className="meal-label">内容を確認（金額・品名は直せます）</span>
                        <ul>
                          {drafts.map((d, index) => (
                            <li key={index} className={d.use ? "" : "off"}>
                              <input
                                type="checkbox"
                                checked={d.use}
                                aria-label={`${d.item}を記録する`}
                                onChange={(event) => updateDraft(index, { use: event.target.checked })}
                              />
                              <select value={d.kind} onChange={(event) => updateDraft(index, { kind: event.target.value as MealKind })}>
                                {KINDS.map((value) => (
                                  <option key={value} value={value}>
                                    {MEAL_LABEL[value]}
                                  </option>
                                ))}
                              </select>
                              <input value={d.item} onChange={(event) => updateDraft(index, { item: event.target.value })} aria-label="品名" />
                              <input
                                value={d.price ?? ""}
                                inputMode="numeric"
                                aria-label="金額"
                                placeholder="円"
                                onChange={(event) => {
                                  const digits = event.target.value.replace(/[^0-9]/g, "");
                                  updateDraft(index, { price: digits ? Number(digits) : null, priceSource: digits ? d.priceSource || "estimate" : null });
                                }}
                              />
                              <small>
                                {d.price !== null && (d.priceSource === "receipt" ? "レシート" : "推定")}
                                {d.kcal ? ` ${kcalText(d.kcal)}` : ""}
                                {d.protein !== null && d.protein !== undefined ? ` P${d.protein}` : ""}
                                {d.fat !== null && d.fat !== undefined ? ` F${d.fat}` : ""}
                                {d.carbs !== null && d.carbs !== undefined ? ` C${d.carbs}` : ""}
                              </small>
                            </li>
                          ))}
                        </ul>
                        <button type="button" className="button primary" onClick={saveDrafts} disabled={busy || !drafts.some((d) => d.use)}>
                          {drafts.filter((d) => d.use).length}品をまとめて記録
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <form
              className="ms-entry"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                saveExpense(String(form.get("expenseItem") || ""), String(form.get("expenseAmount") || ""));
              }}
            >
              <input name="expenseItem" className="ms-item" value={expenseItem} onChange={(event) => setExpenseItem(event.target.value)} placeholder="何に使った？（例：ドラッグストア）" aria-label="何に使ったか" />
              <div className="ms-entry-row">
                <label className="ms-yen">
                  <span>¥</span>
                  <input name="expenseAmount" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} inputMode="numeric" placeholder="金額" aria-label="金額" />
                </label>
                <button className="button primary" type="submit" disabled={busy}>記録</button>
              </div>
              <div className="ms-chips">
                {recentExpenseItems.map((name) => (
                  <button key={name} type="button" className="ms-chip" onClick={() => setExpenseItem(name)}>
                    <span>{name}</span>
                  </button>
                ))}
              </div>
            </form>
          )}

          {message && <p className="meal-message ms-toast" role="status">{message}</p>}

          <div className="ms-day">
            <div className="ms-day-head">
              <button type="button" aria-label="前の日" onClick={() => setViewDate(shiftDateKey(viewDate, -1))}>
                <ChevronLeft size={18} />
              </button>
              <div>
                <strong>{viewLabel}</strong>
                <small>
                  支払 {yen(walletOn(memos, viewDate))}
                  {kcalOn(memos, viewDate) > 0 && ` ・ ${kcalText(kcalOn(memos, viewDate))}`}
                </small>
              </div>
              <button type="button" aria-label="次の日" disabled={viewDate >= today} onClick={() => setViewDate(shiftDateKey(viewDate, 1))}>
                <ChevronRight size={18} />
              </button>
            </div>
            {dayRecords.length === 0 ? (
              <p className="meal-empty">記録はありません</p>
            ) : (
              <ul className="ms-list">
                {dayRecords.map((m) => {
                  const at = m.meal?.at || m.expense!.at;
                  const name = m.meal ? m.meal.item : m.expense!.item;
                  const amount = m.meal ? m.meal.price : Number(m.expense!.amount);
                  return (
                    <li key={m.id}>
                      <time>{new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</time>
                      <b className={`ms-tag ${m.meal ? m.meal.kind : "expense"}`}>{m.meal ? MEAL_LABEL[m.meal.kind] : "支出"}</b>
                      <span className="ms-name">
                        {name}
                        {(m.meal?.place || m.meal?.kcal) && (
                          <small>{[m.meal?.place, m.meal?.kcal ? kcalText(m.meal.kcal) : ""].filter(Boolean).join("・")}</small>
                        )}
                      </span>
                      <span className="ms-amount">
                        {amount !== null && amount !== undefined ? yen(amount) : "—"}
                        {m.meal && paidAmount(m.meal) !== (m.meal.price || 0) && <small>支払{yen(paidAmount(m.meal))}</small>}
                      </span>
                      <button
                        type="button"
                        aria-label={`${name}の記録を削除`}
                        onClick={() => removeMeal(m.id).then(() => syncNow().catch(() => undefined))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="ms-link ms-reminder"
            onClick={() => setMealReminder({ enabled: !reminder.enabled })}
          >
            {reminder.enabled ? <Bell size={14} /> : <BellOff size={14} />}
            平日12:45のお昼通知：{reminder.enabled ? "ON" : "OFF"}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Settings: how often SASSHY was opened on this device (baseline for the "open more often" experiment). */
export function OpenCountPanel() {
  const log = useLiveQuery(() => db.settings.get("openLog"), [], undefined) as
    | { days?: Record<string, number> }
    | undefined;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86_400_000);
    const key = localDateKey(d);
    return { key, label: `${d.getMonth() + 1}/${d.getDate()}`, count: log?.days?.[key] || 0 };
  });
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <section className="settings-section open-count">
      <h2>SASSHYを開いた回数（この端末・直近7日）</h2>
      <p className="settings-hint">1日平均 {(total / 7).toFixed(1)} 回。2分以内に開き直した分は1回と数えます。</p>
      <div className="open-count-bars">
        {days.map((d) => (
          <div key={d.key} title={`${d.label} ${d.count}回`}>
            <span style={{ height: `${Math.round((d.count / max) * 100)}%` }} />
            <small>{d.count}</small>
            <small>{d.label}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
