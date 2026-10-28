import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Download } from "lucide-react";
import { db } from "./db";
import { MEAL_LABEL, PAYMENT_LABEL, isMealMemo, localDateKey, mealsOn, paidAmount } from "./meals";
import { RecordEditSheet } from "./RecordEditSheet";
import type { Memo } from "./types";

/**
 * 記録 › 食事: everything eaten, kept for later analysis. A month calendar
 * (calories per day), the chosen day's meals (tap to fix), a monthly summary,
 * and a CSV export of all meals.
 */
const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;
const n = (v: number) => Math.round(v).toLocaleString("ja-JP");

export function mealsCsv(memos: Memo[]): string {
  const rows = memos
    .filter((m) => !m.deletedAt && !m.archived && isMealMemo(m))
    .sort((a, b) => a.meal!.at.localeCompare(b.meal!.at))
    .map((m) => {
      const x = m.meal!;
      const at = new Date(x.at);
      const cell = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [
        localDateKey(at), `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
        MEAL_LABEL[x.kind], x.item, x.price, paidAmount(x), x.payment ? PAYMENT_LABEL[x.payment] : PAYMENT_LABEL.self,
        x.place, x.kcal, x.protein, x.fat, x.carbs,
      ].map(cell).join(",");
    });
  return ["日付,時刻,種類,品名,値段,支払った額,支払い,場所,kcal,たんぱく質g,脂質g,炭水化物g", ...rows].join("\n");
}

/** iPhone: the share sheet (save to Files, send to ChatGPT…). Browser: a download. */
async function exportCsv(memos: Memo[]): Promise<string> {
  const csv = "\ufeff" + mealsCsv(memos);
  const name = `sasshy-meals-${localDateKey(Date.now())}.csv`;
  try {
    const file = new File([csv], name, { type: "text/csv" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "SASSHYの食事記録" });
      return "共有の画面から保存・送信できます";
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "";
  }
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    return "ダウンロードしました";
  } catch {
    await navigator.clipboard?.writeText(csv).catch(() => undefined);
    return "コピーしました（メモやAIに貼り付けできます）";
  }
}

export function MealsLog() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const today = localDateKey(Date.now());
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [editing, setEditing] = useState<Memo | null>(null);
  const [copied, setCopied] = useState("");
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const keys = Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const shift = (d: number) => {
    const x = new Date(y, m - 1 + d, 1);
    setMonth(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  };

  const perDay = keys.map((key) => {
    const list = mealsOn(memos, key);
    return {
      key,
      list,
      kcal: list.reduce((s, x) => s + (x.meal!.kcal || 0), 0),
      spend: list.reduce((s, x) => s + paidAmount(x.meal!), 0),
    };
  });
  const recorded = perDay.filter((d) => d.list.length);
  const kcalDays = perDay.filter((d) => d.kcal > 0);
  const monthMeals = recorded.flatMap((d) => d.list);
  const sum = (f: (x: Memo) => number) => monthMeals.reduce((s, x) => s + f(x), 0);
  const avgKcal = kcalDays.length ? kcalDays.reduce((s, d) => s + d.kcal, 0) / kcalDays.length : 0;
  const pfcDays = Math.max(1, kcalDays.length);
  const top = [...monthMeals.reduce((map, x) => map.set(x.meal!.item, (map.get(x.meal!.item) || 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const home = monthMeals.filter((x) => x.meal!.payment === "home" || /家|実家/.test(x.meal!.place || "")).length;
  const maxKcal = Math.max(1, ...perDay.map((d) => d.kcal));
  const day = perDay.find((d) => d.key === selected);
  const dayList = day ? day.list : mealsOn(memos, selected);
  const sel = new Date(`${selected}T12:00:00`);

  return (
    <div className="ml">
      <div className="dm-nav">
        <button type="button" aria-label="前の月" onClick={() => shift(-1)}>‹</button>
        <strong>{y}年{m}月</strong>
        <button type="button" aria-label="次の月" disabled={month >= today.slice(0, 7)} onClick={() => shift(1)}>›</button>
      </div>

      <section className="rec-card ml-cal">
        <div className="dm-grid dm-head" aria-hidden="true">{["月", "火", "水", "木", "金", "土", "日"].map((d) => <span key={d}>{d}</span>)}</div>
        <div className="dm-grid">
          {Array.from({ length: lead }, (_, i) => <span key={`e${i}`} />)}
          {perDay.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`ml-day${d.key === selected ? " selected" : ""}${d.key === today ? " today" : ""}${d.list.length ? " has" : ""}`}
              style={d.kcal ? { ["--fill" as string]: `${Math.round(18 + (d.kcal / maxKcal) * 55)}%` } : undefined}
              disabled={d.key > today}
              onClick={() => setSelected(d.key)}
            >
              <strong>{Number(d.key.slice(8))}</strong>
              <small>{d.kcal ? n(d.kcal) : d.list.length ? `${d.list.length}品` : ""}</small>
            </button>
          ))}
        </div>
        <small className="dm-legend">数字はその日のkcal。色が濃いほど多い</small>
      </section>

      <section className="rec-card ml-dayc">
        <header><h2>{sel.getMonth() + 1}/{sel.getDate()}（{sel.toLocaleDateString("ja-JP", { weekday: "short" })}）</h2>
          <small>{day?.kcal ? `${n(day.kcal)}kcal・` : ""}{yen(day?.spend || 0)}</small></header>
        {dayList.length === 0 && <p className="ml-empty">記録はありません</p>}
        <ul className="ml-list">
          {dayList.map((x) => {
            const meal = x.meal!;
            return (
              <li key={x.id}>
                <button type="button" onClick={() => setEditing(x)}>
                  <time>{new Date(meal.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</time>
                  <b className={`ms-tag ${meal.kind}`}>{MEAL_LABEL[meal.kind]}</b>
                  <span className="ml-item">
                    {meal.item}
                    <small>{[meal.kcal ? `${n(meal.kcal)}kcal` : "", meal.protein !== undefined && meal.protein !== null ? `P${meal.protein}` : "", meal.fat !== undefined && meal.fat !== null ? `F${meal.fat}` : "", meal.carbs !== undefined && meal.carbs !== null ? `C${meal.carbs}` : "", meal.place || ""].filter(Boolean).join(" ・ ")}</small>
                  </span>
                  <span className="ml-yen">{meal.receiptExpenseId && meal.price ? <>{yen(meal.price)}<small>レシートに含む</small></> : meal.price !== null ? yen(paidAmount(meal)) : "—"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rec-card ml-sum">
        <header><h2>{m}月のまとめ</h2><small>{recorded.length}日分・{monthMeals.length}品</small></header>
        <div className="ml-tiles">
          <div><span>1日の平均</span><strong>{avgKcal ? n(avgKcal) : "—"}<small>kcal</small></strong></div>
          <div><span>食費</span><strong>{yen(sum((x) => paidAmount(x.meal!)))}</strong></div>
          <div><span>家で食べた</span><strong>{home}<small>回</small></strong></div>
        </div>
        <div className="ml-pfc">
          <span>1日平均 P {n(sum((x) => x.meal!.protein || 0) / pfcDays)}g</span>
          <span>F {n(sum((x) => x.meal!.fat || 0) / pfcDays)}g</span>
          <span>C {n(sum((x) => x.meal!.carbs || 0) / pfcDays)}g</span>
        </div>
        {top.length > 0 && (
          <div className="ml-top">
            <span>よく食べたもの</span>
            <ol>{top.map(([item, c]) => <li key={item}><span>{item}</span><b>{c}回</b></li>)}</ol>
          </div>
        )}
        <button type="button" className="ml-export" onClick={async () => setCopied(await exportCsv(memos))}>
          <Download size={15} /> 全部の食事をCSVで書き出す（分析用）
        </button>
        {copied && <small className="ml-note">{copied}</small>}
      </section>
      {editing && <RecordEditSheet memo={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
