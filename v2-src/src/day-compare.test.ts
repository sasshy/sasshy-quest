import { describe, expect, it } from 'vitest';
import { estimateBias, gapBlocks, type Block } from './DayCompare';
import type { FocusSession, Task } from './types';

describe('予定と実際', () => {
  it('finds holes of 20 minutes or more between records', () => {
    const blocks: Block[] = [
      { id: 'a', start: 540, end: 555, title: '梱包', kind: 'work' },
      { id: 'b', start: 560, end: 575, title: '梱包', kind: 'work' },
      { id: 'c', start: 620, end: 640, title: '伝票', kind: 'work' },
    ];
    const gaps = gapBlocks(blocks, '2026-10-20', new Date('2026-10-25T00:00:00').getTime());
    expect(gaps.map((g) => [g.start, g.end])).toEqual([[575, 620]]);
  });

  it('shows how much longer a kind of task usually takes', () => {
    const now = new Date('2026-10-24T12:00:00').getTime();
    const task = (id: string): Task => ({ id, title: '梱包', estimateMin: 30, status: 'done', completedAt: '2026-10-23T10:00:00Z', deletedAt: null } as Task);
    const session = (taskId: string, min: number): FocusSession => ({ id: `s${taskId}`, taskId, startedAt: '2026-10-23T09:00:00Z', endedAt: new Date(Date.parse('2026-10-23T09:00:00Z') + min * 60_000).toISOString(), pausedTotalSec: 0, deletedAt: null } as FocusSession);
    expect(estimateBias([task('1'), task('2')], [session('1', 45), session('2', 39)], now)).toEqual([{ title: '梱包', ratio: 1.4, count: 2 }]);
  });
});
