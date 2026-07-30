import { describe, expect, it } from 'vitest';
import { predictDuration, sessionDuration, taskActualDuration, taskFamily, taskWorkedSeconds } from './insights';
import type { FocusSession } from './types';

function session(input: Partial<FocusSession> & Pick<FocusSession, 'id' | 'taskId' | 'taskTitle' | 'startedAt' | 'endedAt'>): FocusSession {
  return {
    plannedMin: 25,
    pausedAt: null,
    pausedTotalSec: 0,
    status: 'completed',
    createdAt: input.startedAt,
    updatedAt: input.endedAt || input.startedAt,
    deletedAt: null,
    sync: { deviceId: 'test' },
    ...input,
  };
}

describe('duration insights', () => {
  it('subtracts paused time from the actual duration', () => {
    const value = sessionDuration(session({
      id: 'one',
      taskId: 'task-one',
      taskTitle: '出荷準備：A',
      startedAt: '2026-07-30T00:00:00.000Z',
      endedAt: '2026-07-30T00:40:00.000Z',
      pausedTotalSec: 600,
    }));
    expect(value).toMatchObject({ activeMin: 30, wallMin: 40, reliable: true });
  });

  it('groups repeated work by the title before the colon', () => {
    expect(taskFamily('出荷準備：SCH40')).toBe(taskFamily('出荷準備：HS25'));
  });

  it('ignores a likely forgotten completion when predicting', () => {
    const values = [
      session({ id: 'a', taskId: 'a', taskTitle: '出荷準備：A', startedAt: '2026-07-27T00:00:00.000Z', endedAt: '2026-07-27T00:20:00.000Z' }),
      session({ id: 'b', taskId: 'b', taskTitle: '出荷準備：B', startedAt: '2026-07-28T00:00:00.000Z', endedAt: '2026-07-28T00:30:00.000Z' }),
      session({ id: 'c', taskId: 'c', taskTitle: '出荷準備：C', startedAt: '2026-07-29T00:00:00.000Z', endedAt: '2026-07-29T04:00:00.000Z' }),
    ];
    expect(predictDuration('出荷準備：D', values)).toEqual({ predictedMin: 25, sampleSize: 2, ignoredCount: 1 });
  });

  it('sums completed sessions for one task', () => {
    const values = [
      session({ id: 'a', taskId: 'same', taskTitle: '確認', startedAt: '2026-07-30T00:00:00.000Z', endedAt: '2026-07-30T00:10:00.000Z' }),
      session({ id: 'b', taskId: 'same', taskTitle: '確認', startedAt: '2026-07-30T01:00:00.000Z', endedAt: '2026-07-30T01:15:00.000Z' }),
    ];
    expect(taskActualDuration('same', values)?.activeMin).toBe(25);
  });

  it('carries interrupted work into the same task total', () => {
    const values = [
      session({ id: 'a', taskId: 'same', taskTitle: '確認', status: 'interrupted', startedAt: '2026-07-30T00:00:00.000Z', endedAt: '2026-07-30T00:08:00.000Z' }),
      session({ id: 'b', taskId: 'same', taskTitle: '確認', startedAt: '2026-07-30T01:00:00.000Z', endedAt: '2026-07-30T01:12:00.000Z' }),
    ];
    expect(taskWorkedSeconds('same', values)).toBe(20 * 60);
    expect(predictDuration('確認', values)).toEqual({ predictedMin: 20, sampleSize: 1, ignoredCount: 0 });
  });
});
