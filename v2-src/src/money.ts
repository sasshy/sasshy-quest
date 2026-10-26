import { budgetPeriod, isShoppingExpense, type BudgetSetting } from './budget';
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

export const CATEGORIES = ['食費', 'ドラッグストア', 'ネット通販', '日用品', '交通', 'カフェ・間食', 'その他'] as const;
export type SpendCategory = (typeof CATEGORIES)[number];

const RULES: [SpendCategory, RegExp][] = [
  ['ドラッグストア', /ドラッグ|drug|薬局|マツキヨ|マツモトキヨシ|ウエルシア|スギ薬局|ツルハ|ココカラ|サンドラッグ/i],
  ['ネット通販', /amazon|アマゾン|楽天|rakuten|yahoo|ヤフー|zozo|メルカリ|lohaco|アスクル|通販/i],
  ['日用品', /ダイソー|ニトリ|無印|ホームセンター|カインズ|コーナン|ロフト|ドンキ|ドン・?キホーテ|日用品|コストコ|ユニクロ/i],
  ['交通', /電車|バス|タクシー|suica|スイカ|pasmo|ガソリン|駐車|高速|新幹線|交通/i],
  ['カフェ・間食', /カフェ|cafe|スタバ|スターバックス|ドトール|タリーズ|コーヒー|珈琲|コンビニ|セブン|ローソン|ファミマ|ファミリーマート|おやつ|お菓子/i],
];

/** 使い道の分類。食事は食費、支出は分類の指定か品名から。 */
export function spendCategory(memo: Memo): SpendCategory {
  if (memo.meal) return '食費';
  const e = memo.expense;
  if (!e) return 'その他';
  const text = `${e.category || ''} ${e.item}`;
  for (const [name, re] of RULES) if (re.test(text)) return name;
  return 'その他';
}

export const amountOf = (memo: Memo): number => (memo.meal ? paidAmount(memo.meal) : Number(memo.expense?.amount || 0));

export interface MoneySummary {
  start: string;
  end: string;
  total: number;
  daily: number;
  shopping: number;
  byDay: { key: string; daily: number; shopping: number }[];
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
    for (const m of list) {
      const a = amountOf(m);
      if (m.expense && isShoppingExpense(m)) shopping += a; else daily += a;
      if (a > 0) records.push(m);
    }
    byDay.push({ key, daily, shopping });
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
  return {
    start,
    end,
    total: daily + shopping,
    daily,
    shopping,
    byDay,
    byCategory: CATEGORIES.map((name) => ({ name, amount: cats.get(name) || 0 })).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount),
    top: [...items.values()].sort((a, b) => b.amount - a.amount).slice(0, 5),
    records: records.sort((a, b) => Date.parse(b.meal?.at || b.expense!.at) - Date.parse(a.meal?.at || a.expense!.at)),
    incomes,
    income: incomes.reduce((s, m) => s + Number(m.income!.amount || 0), 0),
  };
}
