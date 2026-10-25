import { describe, expect, it } from 'vitest';
import { usualMinutes } from './insights';
import type { FocusSession } from './types';

const run = (taskId: string, min: number, extra: Partial<FocusSession> = {}) => {
  const start = Date.parse('2026-10-20T20:00:00Z') - Number(taskId.slice(1)) * 86_400_000;
  return {
    id: `s-${taskId}`, taskId, taskTitle: 'シャワー', status: 'completed', plannedMin: 15, pausedTotalSec: 0,
    startedAt: new Date(start).toISOString(), endedAt: new Date(start + min * 60_000).toISOString(), deletedAt: null, ...extra,
  } as unknown as FocusSession;
};

describe('usualMinutes', () => {
  const task = { id: 'now', title: 'シャワー', estimateMin: 15 };
  it('uses the median of past real runs, to the minute', () => {
    expect(usualMinutes(task, [run('t1', 7), run('t2', 9), run('t3', 8)])).toEqual({ minutes: 8, fromHistory: true });
  });
  it('ignores forgotten timers (huge or auto-stopped)', () => {
    const sessions = [run('t1', 7), run('t2', 9), run('t3', 600), run('t4', 15, { autoStopped: true })];
    expect(usualMinutes(task, sessions).minutes).toBe(8);
  });
  it('falls back to the estimate with fewer than 2 runs', () => {
    expect(usualMinutes(task, [run('t1', 7)])).toEqual({ minutes: 15, fromHistory: false });
  });
});
