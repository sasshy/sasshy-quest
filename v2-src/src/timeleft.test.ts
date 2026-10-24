import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_LEFT, ageOn, daysLived, minuteFromClock, splitSpan, timeLeftItems } from './timeleft';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const byKey = (now: Date) => Object.fromEntries(timeLeftItems(DEFAULT_TIME_LEFT, now).map((i) => [i.key, i]));

describe('timeLeftItems', () => {
  it('counts down week, month, year and the next birthday', () => {
    const items = byKey(at(2026, 10, 24, 15, 0)); // Saturday
    expect(items.week).toMatchObject({ value: '33', unit: '時間' });
    expect(items.month).toMatchObject({ value: '7', unit: '日', extra: '9時間' });
    expect(items.year).toMatchObject({ value: '68', unit: '日' });
    expect(items.birthday).toMatchObject({ label: '37歳まで', value: '45', unit: '日' });
  });

  it('keeps counting the same day until bedtime after midnight', () => {
    const items = byKey(at(2026, 10, 25, 0, 30));
    expect(items.day).toMatchObject({ value: '30', unit: '分' });
    expect(byKey(at(2026, 10, 25, 3, 0)).day).toMatchObject({ value: '0', note: '寝る時間を過ぎています' });
    expect(byKey(at(2026, 10, 25, 9, 0)).day).toMatchObject({ value: '16', unit: '時間' });
  });

  it('shows the user countdowns until the end of that day and drops past ones', () => {
    const setting = { ...DEFAULT_TIME_LEFT, countdowns: [{ id: 'a', label: 'GPT終了', date: '2026-12-11' }, { id: 'b', label: '済', date: '2026-10-01' }] };
    const items = timeLeftItems(setting, at(2026, 10, 24, 12));
    expect(items.map((i) => i.label)).toContain('GPT終了');
    expect(items.map((i) => i.label)).not.toContain('済');
  });
});

describe('helpers', () => {
  it('age and days lived', () => {
    expect(ageOn('1989-12-09', at(2026, 10, 24))).toBe(36);
    expect(ageOn('1989-12-09', at(2026, 12, 9))).toBe(37);
    expect(daysLived('1989-12-09', at(1989, 12, 9))).toBe(1);
  });
  it('splitSpan and clock parsing', () => {
    expect(splitSpan(90 * 60_000)).toEqual({ value: '1', unit: '時間', extra: '30分' });
    expect(minuteFromClock('1:00', true)).toBe(1500);
    expect(minuteFromClock('23:30', true)).toBe(1410);
    expect(minuteFromClock('7:61')).toBeNull();
  });
});
