import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Download, Plus, Trash2 } from "lucide-react";
import { db } from "./db";
import { BUCKET_LABEL, DEFAULT_BUDGET, expenseBucket, getBudget, setBudget } from "./budget";
import { CATEGORY_COLORS, amountOf, moneySummary, periodAt, recordIncome, removeIncome, spendCategory, type SpendCategory } from "./money";
import { expenseDetail, localDateKey } from "./meals";
import { RecordEditSheet } from "./RecordEditSheet";
import { BudgetSheet } from "./BudgetPanel";
import { syncNow } from "./sync";
import { MoneyDay, MoneyWeek } from "./MoneyWeek";
import { AdvanceCard } from "./Advances";
import type { Memo } from "./types";

/**
 * 記録 › お金：給料日から次の給料日までの1か月ごと。合計・2つの枠・収支・
 * 使い道（円グラフ）・日ごと・月ごとの推移・記録の一覧。
 */
const yen = (v: number) => `${v < 0 ? "−" : ""}¥${Math.abs(Math.round(v)).toLocaleString("ja-JP")}`;
const md = (key: string) => {
  const d = new Date(`${key}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const COLORS = CATEGORY_COLORS;

function Donut({ parts, total }: { parts: { name: SpendCategory; amount: number }[]; total: number }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="mo-donut" role="img" aria-label="使い道の割合">
      <circle cx="70" cy="70" r={R} className="mo-donut-bg" />
      {parts.map((p) => {
        const len = total > 0 ? (p.amount / total) * C : 0;
        const el = (
          <circle key={p.name} cx="70" cy="70" r={R} fill="none" stroke={COLORS[p.name]} strokeWidth="20"
            strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)" />
        );
        offset += len;
        return el;
      })}
      <text x="70" y="66" textAnchor="middle" className="mo-donut-label">使った</text>
      <text x="70" y="84" textAnchor="middle" className="mo-donut-total">{yen(total)}</text>
    </svg>
  );
}

function csvOf(records: Memo[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = records.map((m) => {
    const at = new Date(m.meal?.at || m.expense!.at);
    return [localDateKey(at), m.meal ? "食事" : "支出", m.meal?.item || m.expense?.item, amountOf(m), BUCKET_LABEL[m.expense ? expenseBucket(m) : "daily"], spendCategory(m)].map(cell).join(",");
  });
  return ["日付,種類,内容,金額,枠,使い道", ...rows].join("\n");
}

async function shareCsv(text: string, name: string): Promise<string> {
  const csv = "﻿" + text;
  try {
    const file = new File([csv], name, { type: "text/csv" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "SASSHYのお金の記録" });
      return "共有の画面から保存・送信できます";
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "";
  }
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return "ダウンロードしました";
}

export function MoneyPanel() {
  const memos = useLiveQuery(() => db.memos.toArray(), [], []) || [];
  const setting = useLiveQuery(async () => {
    await db.settings.get("budget");
    return getBudget();
  }, [], DEFAULT_BUDGET) || DEFAULT_BUDGET;
  const today = localDateKey(Date.now());
  const [offset, setOffset] = useState(0);
  // 最初は「日ごと」（週ごとの棒と1日ずつの明細）。円グラフや収支は「月のまとめ」。
  const [view, setView] = useState<"day" | "week" | "month">("day");
  const [editing, setEditing] = useState<Memo | null>(null);
  const [incomeDraft, setIncomeDraft] = useState("");
  const [incomeItem, setIncomeItem] = useState("給料");
  const [keepMonthly, setKeepMonthly] = useState(true);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const [budgetOpen, setBudgetOpen] = useState(false);

  const { start, end } = periodAt(today, setting.startDay, offset);
  const sum = useMemo(() => moneySummary(memos, setting, start, end), [memos, setting, start, end]);
  const months = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const p = periodAt(today, setting.startDay, offset - 5 + i);
    const s = moneySummary(memos, setting, p.start, p.end);
    return { start: p.start, total: s.total };
  }), [memos, setting, offset, today]);
  const last = months[4]?.total ?? 0;
  const maxMonth = Math.max(1, ...months.map((m) => m.total));
  const maxDay = Math.max(1, ...sum.byDay.map((d) => d.daily + d.shopping + d.outside));
  const current = offset === 0;
  const expected = sum.incomes.length === 0 && setting.incomeMonthly > 0;
  const income = sum.income || (expected ? setting.incomeMonthly : 0);

  const saveIncome = async (amount: number, item: string) => {
    try {
      // 期間の始まり（給料日）に入ったことにする。
      await recordIncome({ item, amount, at: new Date(`${start}T09:00:00`).toISOString() });
      if (keepMonthly && item === "給料") await setBudget({ incomeMonthly: amount });
      syncNow().catch(() => undefined);
      setIncomeDraft("");
      setAdding(false);
      setNote("");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="mo">
      <div className="mo-tabs" role="tablist" aria-label="お金の見方">
        <button type="button" role="tab" aria-selected={view === "day"} className={view === "day" ? "active" : ""} onClick={() => setView("day")}>1日</button>
        <button type="button" role="tab" aria-selected={view === "week"} className={view === "week" ? "active" : ""} onClick={() => setView("week")}>週</button>
        <button type="button" role="tab" aria-selected={view === "month"} className={view === "month" ? "active" : ""} onClick={() => setView("month")}>月のまとめ</button>
      </div>
      {/* 立て替え中（自分の支出には数えない）。返ってくるまで、どの見方でも上に出す。 */}
      <AdvanceCard memos={memos} />
      {view === "day" ? (
        <MoneyDay memos={memos} setting={setting} />
      ) : view === "week" ? (
        <MoneyWeek memos={memos} setting={setting} />
      ) : (<>
      <div className="dm-nav">
        <button type="button" aria-label="前の月" onClick={() => setOffset(offset - 1)}>‹</button>
        <strong>{md(start)}〜{md(end)}{current ? "（今月）" : ""}</strong>
        <button type="button" aria-label="次の月" disabled={current} onClick={() => setOffset(offset + 1)}>›</button>
      </div>

      <section className="rec-card mo-sum">
        <span className="mo-label">使ったお金</span>
        <div className="mo-big"><strong>{yen(sum.total)}</strong><small>先月 {yen(last)}</small></div>
        <div className="mo-meter">
          <div><span><i style={{ background: "#7F77DD" }} />毎日のお金</span><b>{yen(sum.daily)} / {yen(setting.amount)}</b></div>
          <em><i style={{ width: `${Math.min(100, (sum.daily / Math.max(1, setting.amount)) * 100)}%`, background: "#7F77DD" }} /></em>
        </div>
        <div className="mo-meter">
          <div><span><i style={{ background: "#EF9F27" }} />買い物枠</span><b>{yen(sum.shopping)} / {yen(setting.shoppingAmount)}</b></div>
          <em><i style={{ width: `${Math.min(100, (sum.shopping / Math.max(1, setting.shoppingAmount)) * 100)}%`, background: "#EF9F27" }} /></em>
        </div>
        {sum.outside > 0 && (
          <div className="mo-meter">
            <div><span><i style={{ background: "#E24B4A" }} />予算の外（病院・薬など）</span><b>{yen(sum.outside)}</b></div>
          </div>
        )}
      </section>

      <section className="rec-card mo-balance">
        <header><h2>収支</h2></header>
        <dl>
          <div><dt>入ったお金{expected ? "（見込み）" : ""}</dt><dd>{income ? yen(income) : "—"}</dd></div>
          <div><dt>使ったお金</dt><dd>−{yen(sum.total)}</dd></div>
          <div className="total"><dt>残った</dt><dd>{income ? yen(income - sum.total) : "—"}</dd></div>
        </dl>
        {expected && (
          <button type="button" className="button primary mo-confirm" onClick={() => saveIncome(setting.incomeMonthly, "給料")}>
            今月の給料 {yen(setting.incomeMonthly)} で記録
          </button>
        )}
        {sum.incomes.length > 0 && (
          <ul className="mo-incomes">
            {sum.incomes.map((m) => (
              <li key={m.id}>
                <span>{m.income!.item}<small>{md(localDateKey(new Date(m.income!.at)))}</small></span>
                <b>{yen(m.income!.amount)}</b>
                <button type="button" aria-label={`${m.income!.item}を削除`} onClick={() => removeIncome(m.id).then(() => syncNow().catch(() => undefined))}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        {(adding || (!expected && sum.incomes.length === 0)) ? (
          <form className="mo-income-add" onSubmit={(e) => { e.preventDefault(); saveIncome(Number(incomeDraft.replace(/[^0-9]/g, "")), incomeItem); }}>
            <select value={incomeItem} onChange={(e) => setIncomeItem(e.currentTarget.value)} aria-label="種類">
              <option>給料</option><option>ボーナス</option><option>その他</option>
            </select>
            <input inputMode="numeric" value={incomeDraft} onChange={(e) => setIncomeDraft(e.currentTarget.value)} placeholder="手取り（円）" aria-label="金額" />
            <button type="submit" className="button primary" disabled={!incomeDraft.trim()}>記録</button>
            {incomeItem === "給料" && (
              <label className="mo-keep"><input type="checkbox" checked={keepMonthly} onChange={(e) => setKeepMonthly(e.currentTarget.checked)} />来月からはこの額を見込みにして、ワンタップで記録</label>
            )}
          </form>
        ) : (
          <button type="button" className="ms-link" onClick={() => setAdding(true)}><Plus size={14} /> ボーナスなど収入を追加</button>
        )}
        {note && <small className="ml-note">{note}</small>}
      </section>

      {sum.byCategory.length > 0 && (
        <section className="rec-card mo-cats">
          <header><h2>何に使ったか</h2></header>
          <div className="mo-cats-body">
            <Donut parts={sum.byCategory} total={sum.total} />
            <ul>
              {sum.byCategory.map((c) => (
                <li key={c.name}>
                  <span><i style={{ background: COLORS[c.name] }} />{c.name}</span>
                  <b>{yen(c.amount)}</b>
                  <small>{Math.round((c.amount / Math.max(1, sum.total)) * 100)}%</small>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="rec-card">
        <header><h2>日ごと</h2><small><i className="mo-key" style={{ background: "#7F77DD" }} />毎日 <i className="mo-key" style={{ background: "#EF9F27" }} />買い物枠</small></header>
        <div className="mo-days">
          {sum.byDay.map((d) => (
            <span key={d.key} title={`${md(d.key)} ${yen(d.daily + d.shopping + d.outside)}`} className={d.key === today ? "today" : ""}>
              <i style={{ height: `${(d.outside / maxDay) * 100}%`, background: "#E24B4A" }} />
              <i style={{ height: `${(d.shopping / maxDay) * 100}%`, background: "#EF9F27" }} />
              <i style={{ height: `${(d.daily / maxDay) * 100}%`, background: "#7F77DD" }} />
            </span>
          ))}
        </div>
        <div className="mo-days-axis"><span>{md(start)}</span><span>{md(end)}</span></div>
      </section>

      <section className="rec-card">
        <header><h2>月ごとの推移</h2></header>
        <div className="mo-months">
          {months.map((m, i) => (
            <div key={m.start} className={i === 5 ? "now" : ""}>
              <small>{m.total ? `${Math.round(m.total / 1000)}k` : ""}</small>
              <b style={{ height: `${Math.max(3, (m.total / maxMonth) * 64)}px` }} />
              <span>{Number(m.start.slice(5, 7))}月〜</span>
            </div>
          ))}
        </div>
      </section>

      {sum.top.length > 0 && (
        <section className="rec-card ml-top">
          <span>大きかった支出</span>
          <ol>{sum.top.map((t) => <li key={t.item}><span>{t.item}{t.count > 1 ? `（${t.count}回）` : ""}</span><b>{yen(t.amount)}</b></li>)}</ol>
        </section>
      )}

      <section className="rec-card">
        <header><h2>この期間の記録</h2><small>{sum.records.length}件</small></header>
        <ul className="ml-list">
          {sum.records.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => setEditing(m)}>
                <time>{md(localDateKey(new Date(m.meal?.at || m.expense!.at)))}</time>
                <b className="mo-cat" style={{ background: COLORS[spendCategory(m)] }}>{spendCategory(m)}</b>
                <span className="ml-item">{m.meal?.item || m.expense?.item}{m.expense && expenseBucket(m) !== "daily" && <small>{BUCKET_LABEL[expenseBucket(m)]}</small>}{expenseDetail(m.expense) && <em className="mo-detail">{expenseDetail(m.expense)}</em>}</span>
                <span className="ml-yen">{yen(amountOf(m))}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ml-export" onClick={async () => setNote(await shareCsv(csvOf(sum.records), `sasshy-money-${start}.csv`))}>
          <Download size={15} /> この期間をCSVで書き出す
        </button>
      </section>
      </>)}
      <button type="button" className="button secondary mo-settings" onClick={() => setBudgetOpen(true)}>
        予算と給料日の設定{setting.enabled ? "" : "（今日の画面には表示していません）"}
      </button>
      {editing && <RecordEditSheet memo={editing} onClose={() => setEditing(null)} />}
      {/* 記録の画面は動きのある枠の中なので、シートは画面全体（body）に出す。 */}
      {budgetOpen && createPortal(<BudgetSheet onClose={() => setBudgetOpen(false)} />, document.body)}
    </div>
  );
}
