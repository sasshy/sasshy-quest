import { describe, expect, it } from 'vitest';
import { levelFrom, xpFrom } from './progress';

describe('XP and level (only goes up)', () => {
  it('10 XP per completed task + 1 per minute worked', () => {
    expect(xpFrom({ doneTotal: 3, workTotalMin: 25 })).toBe(55);
  });
  it('100 XP per level, starting at Lv.1', () => {
    expect(levelFrom(0)).toEqual({ level: 1, into: 0, need: 100 });
    expect(levelFrom(99).level).toBe(1);
    expect(levelFrom(100)).toEqual({ level: 2, into: 0, need: 100 });
    expect(levelFrom(1234).level).toBe(13);
  });
});
