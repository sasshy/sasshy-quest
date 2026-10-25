import { describe, expect, it } from 'vitest';
import { bestPastWeek, weekStart, weeklyJars } from './progress';
import type { Task } from './types';

const done = (at: string, extra: Partial<Task> = {}) => ({ status: 'done', completedAt: at, deletedAt: null, ...extra }) as unknown as Task;

describe('今週のビン', () => {
  it('weeks start on Monday', () => {
    expect(weekStart(new Date(2026, 9, 25, 15)).getDate()).toBe(19); // Sun 10/25 → Mon 10/19
    expect(weekStart(new Date(2026, 9, 19, 0, 5)).getDate()).toBe(19);
  });
  it('one marble per finished task, logs and deleted tasks excluded', () => {
    const now = new Date(2026, 9, 25, 15);
    const tasks = [
      done(new Date(2026, 9, 19, 9).toISOString()),
      done(new Date(2026, 9, 25, 1).toISOString()),
      done(new Date(2026, 9, 18, 23).toISOString()),
      done(new Date(2026, 9, 20).toISOString(), { log: 'detour' }),
      done(new Date(2026, 9, 21).toISOString(), { deletedAt: 'x' }),
    ];
    const jars = weeklyJars(tasks, [], now, 2);
    expect(jars.map((j) => j.marbles)).toEqual([1, 2]);
    expect(jars[1].start).toBe('2026-10-19');
  });
  it('best past week ignores this week', () => {
    const now = new Date(2026, 9, 25, 15);
    const tasks = [
      done(new Date(2026, 9, 12).toISOString()), done(new Date(2026, 9, 13).toISOString()),
      done(new Date(2026, 9, 6).toISOString()),
      done(new Date(2026, 9, 20).toISOString()), done(new Date(2026, 9, 21).toISOString()), done(new Date(2026, 9, 22).toISOString()),
    ];
    expect(bestPastWeek(tasks, now)).toBe(2);
  });
});
