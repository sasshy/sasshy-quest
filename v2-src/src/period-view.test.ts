import { describe, expect, it } from 'vitest';
import { periodInfo } from './PeriodView';

describe('地図の期間', () => {
  const now = new Date(2026, 9, 25, 12);
  it('counts down to the next birthday in days, the life in weeks', () => {
    const b = periodInfo('birthday', '1989-12-09', now);
    expect(b.label).toBe('37歳まで');
    expect(b.cells).toBe(365);
    expect(periodInfo('life', '1989-12-09', now)).toMatchObject({ unit: 'week', left: { unit: '週' } });
  });
  it('this week has 7 cells starting Monday', () => {
    const w = periodInfo('week', '1989-12-09', now);
    expect(w.cells).toBe(7);
    expect(new Date(w.start).getDay()).toBe(1);
  });
});
