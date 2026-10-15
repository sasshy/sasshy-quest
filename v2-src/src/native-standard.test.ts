import { describe, expect, it } from 'vitest';
import { buildStandardPrompts, mergePrompts } from './native-standard';
import type { Memo, Task } from './types';

const now = new Date(2026, 9, 15, 9, 0, 0).getTime();
const task = (over: Partial<Task> & Record<string, unknown>): Task => ({
  id: 't1', title: '見積を送る', status: 'planned', scheduledDate: '2026-10-15', startMinute: 600,
  deletedAt: null, ...over,
} as unknown as Task);
const memo = (over: Partial<Memo>): Memo => ({
  id: 'm1', title: '薬局', body: '受け取り', archived: false, deletedAt: null,
  reminderAt: new Date(2026, 9, 15, 12, 0).toISOString(), ...over,
} as unknown as Memo);

describe('buildStandardPrompts', () => {
  it('schedules a task at its start time', () => {
    const [p] = buildStandardPrompts([task({})], [], now);
    expect(p.title).toBe('予定の時間です');
    expect(p.body).toBe('見積を送る');
    expect(new Date(p.fireAt).getTime()).toBe(new Date(2026, 9, 15, 10, 0).getTime());
  });

  it('keeps legacy tasks on, honours an explicit off', () => {
    expect(buildStandardPrompts([task({ scheduledStartNotification: false })], [], now)).toHaveLength(0);
    expect(buildStandardPrompts([task({ scheduledStartNotification: true })], [], now)).toHaveLength(1);
  });

  it('skips done, archived, active, deleted, past, untimed and far-future tasks', () => {
    const skipped = [
      task({ status: 'done' }), task({ status: 'archived' }), task({ status: 'active' }),
      task({ deletedAt: '2026-10-14T00:00:00Z' }), task({ startMinute: 480 }), task({ startMinute: null }),
      task({ scheduledDate: null }), task({ scheduledDate: '2026-10-30' }),
    ];
    expect(buildStandardPrompts(skipped, [], now)).toHaveLength(0);
  });

  it('schedules memo reminders and skips archived or deleted memos', () => {
    const prompts = buildStandardPrompts([], [memo({}), memo({ id: 'm2', archived: true }), memo({ id: 'm3', deletedAt: 'x' }), memo({ id: 'm4', reminderAt: null })], now);
    expect(prompts.map((p) => p.id)).toEqual([`memo-m1-${new Date(2026, 9, 15, 12, 0).getTime()}`]);
    expect(prompts[0].title).toBe('薬局');
  });
});

describe('mergePrompts', () => {
  it('orders soonest first, removes duplicate ids and caps the total', () => {
    const at = (h: number) => new Date(2026, 9, 15, h).toISOString();
    const a = [{ id: 'x', fireAt: at(12), title: '', body: '' }, { id: 'y', fireAt: at(10), title: '', body: '' }];
    const b = [{ id: 'x', fireAt: at(12), title: '', body: '' }, { id: 'z', fireAt: at(11), title: '', body: '' }];
    expect(mergePrompts([a, b]).map((p) => p.id)).toEqual(['y', 'z', 'x']);
    expect(mergePrompts([a, b], 2)).toHaveLength(2);
  });
});
