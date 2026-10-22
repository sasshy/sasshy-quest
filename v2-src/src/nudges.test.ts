import { describe, expect, it } from 'vitest';
import { DEFAULT_NUDGES, nudgePrompts } from './nudges';
import type { Task } from './types';

const task = (title: string, flowOrder: number): Task => ({
  id: title, title, notes: '', status: 'planned', horizon: 'now', scheduledDate: '2026-10-23', startMinute: null,
  durationMin: 10, estimateMin: 10, importance: 0, urgency: 0, createdAt: '', updatedAt: '', completedAt: null,
  deletedAt: null, source: 'v2', flowOrder, sync: { deviceId: 't' },
});

describe('daily nudges', () => {
  it('morning names the first task of the day; night offers the routine; weekends skip the morning', () => {
    const now = new Date(2026, 9, 22, 22, 0).getTime(); // Thu night
    const prompts = nudgePrompts([task('在庫チェック', 1), task('台車の発注', 0)], DEFAULT_NUDGES, now);
    const ids = prompts.map((p) => p.id);
    expect(prompts.find((p) => p.id === 'nudge-morning-2026-10-23')?.title).toBe('今日の1つ目：台車の発注');
    expect(ids).toContain('nudge-night-2026-10-23');
    expect(ids).not.toContain('nudge-morning-2026-10-24'); // Saturday
    expect(ids).not.toContain('nudge-night-2026-10-22'); // already past
  });
  it('can be turned off', () => {
    expect(nudgePrompts([], { ...DEFAULT_NUDGES, enabled: false })).toEqual([]);
  });
});
