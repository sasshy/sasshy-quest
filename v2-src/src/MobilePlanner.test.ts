import { describe, expect, it } from 'vitest';
import { planDay } from './MobilePlanner';
import type { Task } from './types';

const task = (id: string, estimateMin: number, startMinute: number | null = null, flowOrder?: number): Task => ({
  id, title: id, notes: '', status: 'planned', horizon: 'now', scheduledDate: '2026-10-23', startMinute,
  isFixed: startMinute !== null, durationMin: estimateMin, estimateMin, importance: 0, urgency: 0,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', completedAt: null, deletedAt: null,
  source: 'v2', flowOrder, sync: { deviceId: 't' },
});

describe('phone day plan', () => {
  const now = new Date(2026, 9, 22, 12, 0); // the planned day is tomorrow → starts at 8:00
  it('shows free gaps between fixed and flexible tasks', () => {
    const tasks = [task('朝の持出し', 45, 9 * 60), task('在庫チェック', 20, null, 0)];
    const { rows, busy, free } = planDay(tasks, '2026-10-23', ['在庫チェック'], now);
    expect(rows.map((r) => (r.kind === 'gap' ? `空き${r.end - r.start}` : r.task.id))).toEqual([
      '在庫チェック', '空き40', '朝の持出し', `空き${22 * 60 - (9 * 60 + 45)}`,
    ]);
    expect(busy).toBe(65);
    expect(free).toBe(14 * 60 - 65);
  });

  it('flexible tasks follow the given order (drag result)', () => {
    const tasks = [task('A', 10, null, 0), task('B', 10, null, 1)];
    const ids = (order: string[]) => planDay(tasks, '2026-10-23', order, now).rows.filter((r) => r.kind === 'task').map((r) => r.kind === 'task' && r.task.id);
    expect(ids(['A', 'B'])).toEqual(['A', 'B']);
    expect(ids(['B', 'A'])).toEqual(['B', 'A']);
  });
});
