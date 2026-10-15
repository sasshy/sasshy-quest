import { describe, expect, it } from 'vitest';
import { addOpen } from './open-log';

describe('addOpen', () => {
  const t = (h: number, m = 0) => new Date(2026, 9, 15, h, m).getTime();
  it('counts opens per day and ignores re-opens within 2 minutes', () => {
    let log = addOpen(undefined, t(9));
    log = addOpen(log, t(9, 1));
    log = addOpen(log, t(9, 5));
    expect(log.days['2026-10-15']).toBe(2);
  });
  it('keeps at most 90 days', () => {
    let log = addOpen(undefined, new Date(2026, 0, 1).getTime());
    for (let i = 1; i < 120; i++) log = addOpen(log, new Date(2026, 0, 1 + i).getTime());
    expect(Object.keys(log.days)).toHaveLength(90);
  });
});
