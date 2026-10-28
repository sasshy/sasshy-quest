import type { Memo, Task } from './types';
import { isDiaryMemo } from './diary';
import { isExpenseMemo, isMealMemo, localDateKey } from './meals';
import { isHabitMemo } from './habits';
import { amountOf, isIncomeMemo } from './money';

/**
 * 全部から探す：タスク・お金（支出・食事・収入）・日記・習慣・メモ。
 * スペースで区切った言葉が全部入っているものを、新しい順に返す。金額でも探せる。
 */
export type HitKind = 'task' | 'money' | 'meal' | 'diary' | 'habit' | 'memo';
export interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  sub: string;
  date: string;
  amount: number | null;
  task?: Task;
  memo?: Memo;
}

export const norm = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[¥,円\s]/g, ' ').replace(/\s+/g, ' ').trim();

function memoText(m: Memo): string {
  const parts: unknown[] = [m.title, m.body];
  if (m.expense) {
    const e = m.expense as unknown as Record<string, unknown>;
    parts.push(e.item, e.category, e.store, e.paymentMethod, e.amount);
    if (Array.isArray(e.itemBreakdown)) for (const b of e.itemBreakdown as { item?: string }[]) parts.push(b?.item);
  }
  if (m.meal) parts.push(m.meal.item, m.meal.place, m.meal.price, (m.meal as { paid?: number }).paid);
  if (m.income) parts.push(m.income.item, m.income.amount);
  if (m.habit) parts.push(m.habit.name);
  return norm(parts.filter((v) => v !== null && v !== undefined).join(' '));
}

export function searchAll(query: string, tasks: Task[], memos: Memo[], limit = 80): Hit[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const has = (text: string) => words.every((w) => text.includes(w));
  const hits: Hit[] = [];
  for (const t of tasks) {
    if (t.deletedAt) continue;
    const text = norm(`${t.title} ${t.notes || ''}`);
    if (!has(text)) continue;
    const date = t.completedAt ? localDateKey(t.completedAt) : t.scheduledDate || localDateKey(t.updatedAt || t.createdAt);
    const state = t.status === 'done' ? '完了' : t.scheduledDate ? `予定 ${t.scheduledDate.slice(5).replace('-', '/')}` : 'やること';
    hits.push({ kind: 'task', id: t.id, title: t.title, sub: state, date, amount: null, task: t });
  }
  for (const m of memos) {
    if (m.deletedAt) continue;
    if (!has(memoText(m))) continue;
    if (isExpenseMemo(m) || isIncomeMemo(m)) {
      const at = m.expense?.at || m.income!.at;
      hits.push({ kind: 'money', id: m.id, title: m.expense?.item || m.income!.item, sub: m.income ? '収入' : '支出', date: localDateKey(at), amount: m.income ? Number(m.income.amount) : amountOf(m), memo: m });
    } else if (isMealMemo(m)) {
      hits.push({ kind: 'meal', id: m.id, title: m.meal!.item, sub: '食事', date: localDateKey(m.meal!.at), amount: m.meal!.price ?? null, memo: m });
    } else if (isDiaryMemo(m)) {
      hits.push({ kind: 'diary', id: m.id, title: (m.body || m.title).slice(0, 80), sub: '日記', date: m.diary?.date || localDateKey(m.createdAt), amount: null, memo: m });
    } else if (isHabitMemo(m)) {
      hits.push({ kind: 'habit', id: m.id, title: m.habit!.name, sub: m.archived ? '習慣（しまった）' : '習慣', date: localDateKey(m.updatedAt), amount: null, memo: m });
    } else if (!m.archived) {
      hits.push({ kind: 'memo', id: m.id, title: m.title || m.body.slice(0, 60), sub: m.category || 'メモ', date: localDateKey(m.updatedAt || m.createdAt), amount: null, memo: m });
    }
  }
  return hits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}
