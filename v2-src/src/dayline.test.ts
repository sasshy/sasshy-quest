import { describe, expect, it } from 'vitest';
import { minuteFrom, workDayKey } from './dayline';

describe('1日の区切りは夜中4時', () => {
  it('0時〜4時は前の日の夜として数える', () => {
    expect(workDayKey(new Date(2026, 9, 27, 0, 30))).toBe('2026-10-26');
    expect(workDayKey(new Date(2026, 9, 27, 3, 59))).toBe('2026-10-26');
    expect(workDayKey(new Date(2026, 9, 27, 4, 0))).toBe('2026-10-27');
  });
  it('夜中の時刻はその日の24時を越えた分で表す', () => {
    expect(minuteFrom('2026-10-26', new Date(2026, 9, 27, 0, 30))).toBe(24 * 60 + 30);
    expect(minuteFrom('2026-10-26', new Date(2026, 9, 26, 21, 15))).toBe(21 * 60 + 15);
  });
});
