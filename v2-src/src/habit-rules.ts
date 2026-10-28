import type { Memo } from './types';
import { localDateKey, paidAmount } from './meals';
import { spendCategory } from './money';

/**
 * 記録から自動で決まる習慣（例：お昼と間食で800円以内）。
 * 手で✓は付けない。会食・ランチ会の日は数えない（✓にも×にもしない）。
 */
export type RuleState = 'done' | 'over' | 'skip' | 'pending' | 'none';

const SOCIAL = /会食|ランチ会|飲み会|歓迎会|送別会|接待|懇親会/;
const FOOD = new Set(['食費', 'カフェ・間食']);
// 分類が「その他」でも、品名が食べ物なら食費として数える。
const FOOD_WORDS = /ランチ|昼食|昼ごはん|昼飯|弁当|定食|そば|蕎麦|うどん|ラーメン|カレー|丼|パン|おにぎり|サンド|飲食|食事|ごはん|ご飯|間食|おやつ|ドリンク|飲み物/;

const when = (m: Memo): string | null => {
  if (m.meal) return (typeof (m.meal as { purchaseAt?: unknown }).purchaseAt === 'string' ? (m.meal as unknown as { purchaseAt: string }).purchaseAt : m.meal.at) || null;
  if (m.expense) return (typeof m.expense.purchaseAt === 'string' ? m.expense.purchaseAt : m.expense.at) || null;
  return null;
};

export function isRuleHabit(memo: Memo): boolean {
  return Boolean(memo.habit?.rule);
}

/** その日の対象の支出と、✓かどうか。 */
export function ruleDay(memo: Memo, memos: Memo[], date: string, today = localDateKey(Date.now())): { state: RuleState; spent: number } {
  const rule = memo.habit?.rule;
  if (!rule) return { state: 'none', spent: 0 };
  const start = memo.habit!.startDate || localDateKey(memo.createdAt);
  if (date < start || date > today) return { state: 'none', spent: 0 };
  let spent = 0;
  let social = false;
  for (const m of memos) {
    if (m.deletedAt || m.archived || (!m.meal && !m.expense)) continue;
    const at = when(m);
    if (!at || localDateKey(at) !== date) continue;
    const hour = new Date(at).getHours();
    if (hour < rule.fromHour || hour >= rule.toHour) continue;
    const text = m.meal ? `${m.meal.item} ${m.meal.place || ''}` : `${m.expense!.item} ${m.expense!.category || ''}`;
    if (SOCIAL.test(text) || (m.meal as { social?: boolean } | undefined)?.social) social = true;
    if (m.meal) spent += paidAmount(m.meal);
    else if (FOOD.has(spendCategory(m)) || FOOD_WORDS.test(text)) spent += Number(m.expense!.amount || 0);
  }
  if (social) return { state: 'skip', spent };
  if (spent > rule.limit) return { state: 'over', spent };
  return { state: date === today ? 'pending' : 'done', spent };
}

/** ✓になった日（今日は上限以内ならいったん含める）。 */
export function ruleDoneDays(memo: Memo, memos: Memo[], dates: string[]): string[] {
  return dates.filter((d) => {
    const s = ruleDay(memo, memos, d).state;
    return s === 'done' || s === 'pending';
  });
}

export const yenText = (v: number) => `¥${Math.round(v).toLocaleString('ja-JP')}`;
