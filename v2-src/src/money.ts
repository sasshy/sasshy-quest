import { budgetPeriod, expenseBucket, type BudgetSetting } from './budget';
import { expensesOn, localDateKey, mealsOn, paidAmount, shiftDateKey } from './meals';
import { createMemo, updateMemo } from './store';
import type { Memo } from './types';

/**
 * 記録 › お金：給料日から次の給料日までの1か月ごとに、使ったお金・入ったお金・
 * 使い道（円グラフ用）をまとめる。支出は使った日に数え、カードの引き落としは数えない。
 */
export const INCOME_CATEGORY = '収入';

export function isIncomeMemo(memo: Memo): boolean {
  return memo.category === INCOME_CATEGORY && Boolean(memo.income) && !memo.deletedAt && !memo.archived && Number.isFinite(Number(memo.income!.amount));
}

export async function recordIncome(input: { item: string; amount: number; at: string }): Promise<Memo> {
  const item = input.item.trim() || '給料';
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金額を入力してください');
  return createMemo({ title: `収入：${item} ¥${amount.toLocaleString('ja-JP')}`, body: '', category: INCOME_CATEGORY, income: { item, amount, at: input.at } });
}

export async function removeIncome(id: string): Promise<void> {
  await updateMemo(id, { deletedAt: new Date().toISOString(), archived: true }, '収入の記録を削除');
}

/** 今の期間から offset か月ずらした給料日期間。 */
export function periodAt(today: string, startDay: number, offset: number): { start: string; end: string } {
  let { start, end } = budgetPeriod(today, startDay);
  for (let i = 0; i < Math.abs(offset); i += 1) {
    const p = budgetPeriod(offset < 0 ? shiftDateKey(start, -1) : shiftDateKey(end, 1), startDay);
    start = p.start;
    end = p.end;
  }
  return { start, end };
}

export const CATEGORIES = ['食費', '交際', 'AI・サブスク', '日用品', 'ドラッグストア', 'ネット通販', '交通', '医療', 'その他'] as const;
export type SpendCategory = (typeof CATEGORIES)[number];

// 先に当てはまったものが優先。支払いに使ったカード名（Amazon Mastercard など）で
// 判定がずれないよう、AI・サブスクを先に見る。
const SOCIAL = /飲み会|会食|懇親会|歓迎会|送別会|宴会|接待|ランチ会|交際|お祝い|ご祝儀|プレゼント/;
const RULES: [SpendCategory, RegExp][] = [
  ['AI・サブスク', /claude|anthropic|chatgpt|openai|サブスク|月額|netflix|spotify|youtube\s*premium|apple\s*music|icloud|google\s*one|prime会費|プライム会費|(^|[^a-z])ai([^a-z]|$)|AIサービス/i],
  ['交際', SOCIAL],
  ['ネット通販', /アイドラッグ|idrug/i],
  ['医療', /病院|クリニック|医院|診療|歯科|調剤|処方|医療|薬局/i],
  ['食費', /^\s*(食費|食料|飲食|酒)|コンビニ|セブン|ローソン|ファミマ|ファミリーマート|ミニストップ|newdays|デイリーヤマザキ|カフェ|cafe|スタバ|スターバックス|ドトール|タリーズ|コーヒー|珈琲|おやつ|お菓子|弁当|ランチ|昼食|夕食|朝食|定食|ラーメン|そば|うどん|スーパー|マクドナルド|吉野家|松屋|すき家/i],
  ['ドラッグストア', /ドラッグ|drug|マツキヨ|マツモトキヨシ|ウエルシア|スギ薬局|ツルハ|ココカラ|サンドラッグ/i],
  ['ネット通販', /amazon|アマゾン|楽天|rakuten|yahoo|ヤフー|zozo|メルカリ|lohaco|アスクル|通販/i],
  ['日用品', /ダイソー|ニトリ|無印|ホームセンター|カインズ|コーナン|ロフト|ドンキ|ドン・?キホーテ|日用品|コストコ|ユニクロ/i],
  ['交通', /電車|バス|タクシー|suica|スイカ|pasmo|ガソリン|駐車|高速|新幹線|交通/i],
];

/** 使い道の分類。食事は食費（飲み会・会食は交際）、支出は分類の指定か品名から。 */
export function spendCategory(memo: Memo): SpendCategory {
  if (memo.meal) return SOCIAL.test(`${memo.meal.item} ${memo.meal.place || ''}`) ? '交際' : '食費';
  const e = memo.expense;
  if (!e) return 'その他';
  const text = `${e.category || ''} ${e.item}`;
  for (const [name, re] of RULES) if (re.test(text)) return name;
  return 'その他';
}

/** 使い道ごとの色（円グラフ・明細・週の画面で共通）。 */
export const CATEGORY_COLORS: Record<SpendCategory, string> = {
  食費: "#7F77DD",
  交際: "#D85A30",
  "AI・サブスク": "#1D9E75",
  日用品: "#639922",
  ドラッグストア: "#EF9F27",
  ネット通販: "#D4537E",
  交通: "#378ADD",
  医療: "#E24B4A",
  その他: "#888780",
};

export const amountOf = (memo: Memo): number => (memo.meal ? paidAmount(memo.meal) : Number(memo.expense?.amount || 0));

export interface MoneySummary {
  start: string;
  end: string;
  total: number;
  daily: number;
  shopping: number;
  outside: number;
  byDay: { key: string; daily: number; shopping: number; outside: number }[];
  byCategory: { name: SpendCategory; amount: number }[];
  top: { item: string; amount: number; count: number }[];
  records: Memo[];
  incomes: Memo[];
  income: number;
}

export function moneySummary(memos: Memo[], setting: BudgetSetting, start: string, end: string): MoneySummary {
  const byDay: MoneySummary['byDay'] = [];
  const records: Memo[] = [];
  for (let key = start; key <= end; key = shiftDateKey(key, 1)) {
    const list = [...mealsOn(memos, key), ...expensesOn(memos, key)];
    let daily = 0;
    let shopping = 0;
    let outside = 0;
    for (const m of list) {
      const a = amountOf(m);
      const bucket = m.expense ? expenseBucket(m) : 'daily';
      if (bucket === 'shopping') shopping += a; else if (bucket === 'outside') outside += a; else daily += a;
      if (a > 0) records.push(m);
    }
    byDay.push({ key, daily, shopping, outside });
  }
  const cats = new Map<SpendCategory, number>();
  const items = new Map<string, { item: string; amount: number; count: number }>();
  for (const m of records) {
    const a = amountOf(m);
    const c = spendCategory(m);
    cats.set(c, (cats.get(c) || 0) + a);
    const name = (m.meal?.item || m.expense?.item || '').trim();
    const cur = items.get(name) || { item: name, amount: 0, count: 0 };
    cur.amount += a;
    cur.count += 1;
    items.set(name, cur);
  }
  const incomes = memos.filter(isIncomeMemo).filter((m) => {
    const k = localDateKey(new Date(m.income!.at));
    return k >= start && k <= end;
  });
  const daily = byDay.reduce((s, d) => s + d.daily, 0);
  const shopping = byDay.reduce((s, d) => s + d.shopping, 0);
  const outside = byDay.reduce((s, d) => s + d.outside, 0);
  return {
    start,
    end,
    total: daily + shopping + outside,
    daily,
    shopping,
    outside,
    byDay,
    byCategory: CATEGORIES.map((name) => ({ name, amount: cats.get(name) || 0 })).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount),
    top: [...items.values()].sort((a, b) => b.amount - a.amount).slice(0, 5),
    records: records.sort((a, b) => Date.parse(b.meal?.at || b.expense!.at) - Date.parse(a.meal?.at || a.expense!.at)),
    incomes,
    income: incomes.reduce((s, m) => s + Number(m.income!.amount || 0), 0),
  };
}
