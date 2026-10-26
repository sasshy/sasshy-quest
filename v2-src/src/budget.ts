import { db } from './db';
import { expensesOn, localDateKey, recordExpense, shiftDateKey, spendOn } from './meals';
import { createMemo, updateMemo } from './store';
import type { AppSetting, Memo } from './types';

/**
 * Spending budget for one pay period (payday → day before next payday).
 * "今日あと使える" = (budget − spent before today − planned) ÷ days left − spent today.
 * Planned spends ("使う予定のお金") are memos (category 支出予定) so they sync;
 * pressing 使った turns one into a normal spend record, so nothing is counted twice.
 */
/**
 * amount = 毎日のお金（お昼・間食・コンビニ）。今日の「あと使える」はここから。
 * shoppingAmount = 買い物枠（ドラッグストア・Amazonなど月に数回の大きめの買い物）。
 * 大きな買い物で毎日の数字が崩れないよう、別の枠で数える。
 */
export interface BudgetSetting { id: 'budget'; enabled: boolean; amount: number; startDay: number; shoppingAmount: number; /** 毎月の手取り（見込み）。0 = 未設定。 */ incomeMonthly: number }
export const DEFAULT_BUDGET: BudgetSetting = { id: 'budget', enabled: true, amount: 30000, startDay: 25, shoppingAmount: 20000, incomeMonthly: 0 };

const SHOPPING = /amazon|アマゾン|楽天|rakuten|ドラッグ|drug|マツキヨ|マツモトキヨシ|ウエルシア|スギ薬局|ツルハ|ココカラ|サンドラッグ|ダイソー|ニトリ|無印|ヨドバシ|ビックカメラ|ケーズ|カインズ|コーナン|ロフト|ドン・?キホーテ|ドンキ|アスクル|lohaco|yahoo|ヤフー|zozo|メルカリ|ユニクロ|コストコ|ホームセンター|日用品/i;

/** 買い物枠の支出か（指定があればそれ、なければ品名から）。食事は毎日のお金。 */
export function isShoppingExpense(memo: Memo): boolean {
  const e = memo.expense;
  if (!e) return false;
  if (e.bucket) return e.bucket === 'shopping';
  return SHOPPING.test(`${e.item} ${e.category || ''}`);
}
export const PLANNED_CATEGORY = '支出予定';

export interface PlannedSpend { item: string; amount: number; date?: string | null }

export async function getBudget(): Promise<BudgetSetting> {
  const saved = (await db.settings.get('budget')) as unknown as Partial<BudgetSetting> | undefined;
  return { ...DEFAULT_BUDGET, ...(saved || {}), id: 'budget' };
}

export async function setBudget(changes: Partial<Omit<BudgetSetting, 'id'>>): Promise<void> {
  await db.settings.put({ ...(await getBudget()), ...changes } as unknown as AppSetting);
}

export function isPlannedMemo(memo: Memo): boolean {
  return memo.category === PLANNED_CATEGORY && Boolean(memo.planned) && !memo.deletedAt && !memo.archived;
}

/** The pay period containing `today` (start inclusive, end inclusive). */
export function budgetPeriod(today: string, startDay: number): { start: string; end: string; days: number } {
  const [y, m, d] = today.split('-').map(Number);
  const day = Math.min(28, Math.max(1, startDay));
  const startDate = d >= day ? new Date(y, m - 1, day, 12) : new Date(y, m - 2, day, 12);
  const nextStart = new Date(startDate.getFullYear(), startDate.getMonth() + 1, day, 12);
  const start = localDateKey(startDate);
  const end = shiftDateKey(localDateKey(nextStart), -1);
  const days = Math.round((nextStart.getTime() - startDate.getTime()) / 86_400_000);
  return { start, end, days };
}

const spentOn = (memos: Memo[], key: string) =>
  spendOn(memos, key) + expensesOn(memos, key).filter((m) => !isShoppingExpense(m)).reduce((sum, m) => sum + Number(m.expense!.amount || 0), 0);

/** 買い物枠：今の給料日期間に使った額と残り。 */
export function shoppingStatus(memos: Memo[], setting: BudgetSetting, today: string): { budget: number; spent: number; left: number } {
  const { start, end } = budgetPeriod(today, setting.startDay);
  let spent = 0;
  for (let key = start; key <= end && key <= today; key = shiftDateKey(key, 1)) {
    spent += expensesOn(memos, key).filter(isShoppingExpense).reduce((sum, m) => sum + Number(m.expense!.amount || 0), 0);
  }
  const budget = setting.shoppingAmount ?? DEFAULT_BUDGET.shoppingAmount;
  return { budget, spent, left: budget - spent };
}

export interface BudgetStatus {
  budget: number;
  start: string;
  end: string;
  daysLeft: number; // including today
  spentBefore: number;
  spentToday: number;
  planned: number;
  remaining: number; // for the rest of the period after planned spends, before today's spending
  todayAllowance: number;
  todayLeft: number;
  periodLeft: number; // budget − all spent − planned
}

export function budgetStatus(memos: Memo[], setting: BudgetSetting, today: string): BudgetStatus {
  const { start, end } = budgetPeriod(today, setting.startDay);
  let spentBefore = 0;
  for (let key = start; key < today; key = shiftDateKey(key, 1)) spentBefore += spentOn(memos, key);
  const spentToday = spentOn(memos, today);
  const planned = memos
    .filter(isPlannedMemo)
    .filter((m) => !m.planned!.date || (m.planned!.date >= start && m.planned!.date <= end))
    .reduce((sum, m) => sum + Number(m.planned!.amount || 0), 0);
  let daysLeft = 0;
  for (let key = today; key <= end; key = shiftDateKey(key, 1)) daysLeft += 1;
  const remaining = setting.amount - spentBefore - planned;
  const todayAllowance = Math.floor(remaining / Math.max(1, daysLeft));
  return {
    budget: setting.amount,
    start,
    end,
    daysLeft,
    spentBefore,
    spentToday,
    planned,
    remaining,
    todayAllowance,
    todayLeft: todayAllowance - spentToday,
    periodLeft: remaining - spentToday,
  };
}

export async function addPlannedSpend(input: PlannedSpend): Promise<Memo> {
  const item = input.item.trim();
  const amount = Math.round(Number(input.amount));
  if (!item) throw new Error('何に使う予定かを入力してください');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金額を入力してください');
  return createMemo({
    title: `支出予定：${item} ¥${amount.toLocaleString('ja-JP')}`,
    body: '',
    category: PLANNED_CATEGORY,
    planned: { item, amount, date: input.date || null },
  });
}

export async function removePlannedSpend(id: string): Promise<void> {
  await updateMemo(id, { deletedAt: new Date().toISOString(), archived: true }, '支出予定を削除');
}

/** The planned spend happened: record it as a spend and drop the plan. */
export async function markPlannedSpent(memo: Memo, amount?: number): Promise<void> {
  if (!memo.planned) return;
  await recordExpense({ item: memo.planned.item, amount: amount ?? memo.planned.amount });
  await updateMemo(memo.id, { archived: true }, '支出予定を使った');
}
