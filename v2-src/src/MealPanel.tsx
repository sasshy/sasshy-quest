import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Bell, BellOff, ClipboardCopy, ClipboardPaste, Sparkles, Trash2, Utensils, X } from "lucide-react";
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
  recordMeal,
  recordMeals,
  removeMeal,
  setMealReminder,
  spendOn,
  suggestKind,
} from "./meals";
import { syncNow } from "./sync";
import type { MealKind, MealPayment } from "./types";

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
  const spend = spendOn(memos, today);
  const kcal = kcalOn(memos, today);
  const value = valueOn(memos, today);
  return (
    <>
      <section className="meal-strip" aria-label="今日の食事・間食">
        <button className="meal-strip-button" type="button" onClick={() => setOpen(true)}>
          <Utensils size={18} />
          <span>食事・間食を記録</span>
        </button>
        <div className="meal-strip-summary">
          {meals.length === 0 ? (
            <small>今日はまだ記録なし</small>
          ) : (
            <>
              <strong>
                {yen(spend)}
                {value !== spend && <small className="meal-value">（値段{yen(value)}）</small>}
                {kcal > 0 && ` ・ ${kcalText(kcal)}`}
              </strong>
              <small>
                {KINDS.map((k) => {
                  const items = meals.filter((m) => m.meal!.kind === k).map((m) => m.meal!.item);
                  return items.length ? `${MEAL_LABEL[k]} ${items.join("・")}` : "";
                })
                  .filter(Boolean)
                  .join(" ／ ")}
              </small>
            </>
          )}
        </div>
      </section>
      {open && <MealSheet onClose={() => setOpen(false)} />}
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
  const favorites = mealFavorites(memos);
  const today = localDateKey(Date.now());
  const todays = mealsOn(memos, today);

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

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-sheet meal-sheet" role="dialog" aria-modal="true" aria-labelledby="meal-title">
        <header>
          <div>
            <span className="eyebrow">MEAL</span>
            <h2 id="meal-title">食事・間食を記録</h2>
          </div>
          <button className="icon-button" type="button" aria-label="閉じる" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="form-stack">
          <div className="meal-kinds" role="group" aria-label="種類">
            {KINDS.map((value) => (
              <button
                key={value}
                type="button"
                className={kind === value ? "active" : ""}
                onClick={() => setKind(value)}
              >
                {MEAL_LABEL[value]}
              </button>
            ))}
          </div>

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
              <input value={place} onChange={(event) => setPlace(event.target.value)} placeholder="家・会社・店名（任意）" maxLength={60} />
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
            {when && <small className="meal-when-note">{new Date(when).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })} の分として記録します</small>}
          </div>

          {favorites.length > 0 && (
            <div className="meal-favorites">
              <span className="meal-label">よく食べるもの（タップするたびに1品記録）</span>
              <div>
                {favorites.map((fav) => (
                  <button
                    key={fav.item}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      save(
                        { kind, item: fav.item, price: fav.price, kcal: fav.kcal, protein: fav.protein, fat: fav.fat, carbs: fav.carbs, place: place.trim() || fav.place || null },
                        false,
                      )
                    }
                  >
                    <strong>{fav.item}</strong>
                    <small>
                      {[fav.price !== null ? yen(fav.price) : "", fav.kcal ? kcalText(fav.kcal) : ""].filter(Boolean).join(" ・ ")}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="meal-ai">
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

          <form
            className="meal-manual"
            onSubmit={(event) => {
              event.preventDefault();
              save({ kind, item, price: priceValue, paid: paidText.trim() === "" ? null : Number(paidText.replace(/[^0-9]/g, "")) }, false);
            }}
          >
            <label>
              <span>食べたもの</span>
              <input value={item} onChange={(event) => setItem(event.target.value)} placeholder="例：ローソン 唐揚げ弁当" />
            </label>
            <label>
              <span>金額</span>
              <input
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                inputMode="numeric"
                placeholder="円"
              />
            </label>
            {(payment === "split" || payment === "paid_for_others") && (
              <label className="meal-paid">
                <span>実際に払った額</span>
                <input value={paidText} onChange={(event) => setPaidText(event.target.value)} inputMode="numeric" placeholder="円" />
              </label>
            )}
            <button className="button primary" type="submit" disabled={busy || !item.trim()}>
              記録
            </button>
          </form>

          {message && <p className="meal-message" role="status">{message}</p>}

          {todays.length > 0 && (
            <div className="meal-today">
              <span className="meal-label">
                今日の記録（{yen(spendOn(memos, today))}
                {kcalOn(memos, today) > 0 && ` ・ ${kcalText(kcalOn(memos, today))}`}）
              </span>
              <ul>
                {todays.map((m) => (
                  <li key={m.id}>
                    <span>
                      {new Date(m.meal!.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}{" "}
                      {MEAL_LABEL[m.meal!.kind]} {m.meal!.item}
                      {m.meal!.place ? <small className="meal-kcal"> @{m.meal!.place}</small> : null}
                    </span>
                    <span>
                      {m.meal!.kcal ? <small className="meal-kcal">{kcalText(m.meal!.kcal)}</small> : null}
                      {m.meal!.price !== null && yen(m.meal!.price)}
                      {paidAmount(m.meal!) !== (m.meal!.price || 0) && <small className="meal-kcal">（支払{yen(paidAmount(m.meal!))}）</small>}
                      <button
                        type="button"
                        aria-label={`${m.meal!.item}の記録を削除`}
                        onClick={() => removeMeal(m.id).then(() => syncNow().catch(() => undefined))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <footer className="modal-actions meal-footer">
          <button
            type="button"
            className="button secondary"
            onClick={() => setMealReminder({ enabled: !reminder.enabled })}
          >
            {reminder.enabled ? <Bell size={16} /> : <BellOff size={16} />}
            平日12:45のお昼通知：{reminder.enabled ? "ON" : "OFF"}
          </button>
        </footer>
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
