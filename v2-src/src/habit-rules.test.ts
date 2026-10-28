import { describe, expect, it } from 'vitest';
import type { Memo } from './types';
import { ruleDay } from './habit-rules';

const base = { body: '', pinned: false, reminderAt: null, archived: false, deletedAt: null, source: 'v2', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sync: { deviceId: 'x' } };
const habit = { ...base, id: 'h', title: '習慣', category: '習慣', habit: { name: 'お昼', days: [], rule: { kind: 'daytimeFood', limit: 800, fromHour: 9, toHour: 17 }, startDate: '2026-10-20' } } as unknown as Memo;
const spend = (id: string, at: string, item: string, amount: number) => ({ ...base, id, title: item, category: '支出', expense: { at, item, amount } }) as unknown as Memo;
const meal = (id: string, at: string, item: string, paid: number) => ({ ...base, id, title: item, category: '食事', meal: { at, item, kind: 'lunch', paid, payment: 'self' } }) as unknown as Memo;
const local = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString();

describe('お昼と間食◯円以内（自動の習慣）', () => {
  it('9〜17時の食費だけを足して、上限以内なら✓', () => {
    const memos = [spend('a', local('2026-10-27', 12), 'ファミリーマート 昼食', 411), spend('b', local('2026-10-27', 9), 'ローソン おやつ', 171), spend('c', local('2026-10-27', 20), 'ローソン 夜食', 900), spend('d', local('2026-10-27', 13), 'Amazon 本', 2000)];
    expect(ruleDay(habit, memos, '2026-10-27', '2026-10-28')).toEqual({ state: 'done', spent: 582 });
  });
  it('超えたら×、会食の日は数えない、使っていない日は✓', () => {
    expect(ruleDay(habit, [meal('m', local('2026-10-23', 12), 'ランチ', 1333)], '2026-10-23', '2026-10-28').state).toBe('over');
    expect(ruleDay(habit, [meal('m', local('2026-10-23', 12), 'ランチ会 イタリアン', 1800)], '2026-10-23', '2026-10-28').state).toBe('skip');
    expect(ruleDay(habit, [], '2026-10-24', '2026-10-28').state).toBe('done');
    expect(ruleDay(habit, [], '2026-10-10', '2026-10-28').state).toBe('none');
  });
});
describe('品名だけの支出', () => {
  it('「ランチ 定食」も食費として数える', () => {
    expect(ruleDay(habit, [spend('x', local('2026-10-26', 12), 'ランチ 定食', 1200)], '2026-10-26', '2026-10-28').state).toBe('over');
  });
});
