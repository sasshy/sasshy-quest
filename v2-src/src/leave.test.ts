import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAVE, leaveCountdown, leavePrompts } from './leave';

const thu = (h: number, m: number) => new Date(2026, 9, 22, h, m);

describe('leaving work', () => {
  it('counts down from 30 minutes before on weekdays', () => {
    expect(leaveCountdown(DEFAULT_LEAVE, thu(17, 0))).toBeNull();
    expect(leaveCountdown(DEFAULT_LEAVE, thu(17, 10))).toBe(30);
    expect(leaveCountdown(DEFAULT_LEAVE, thu(17, 40))).toBe(0);
    expect(leaveCountdown(DEFAULT_LEAVE, thu(19, 0))).toBe(-80);
    expect(leaveCountdown(DEFAULT_LEAVE, new Date(2026, 9, 24, 17, 20))).toBeNull(); // Saturday
    expect(leaveCountdown({ ...DEFAULT_LEAVE, enabled: false }, thu(17, 20))).toBeNull();
  });

  it('schedules one notification 30 minutes before, weekdays only', () => {
    const prompts = leavePrompts(DEFAULT_LEAVE, thu(9, 0).getTime());
    expect(prompts[0]).toMatchObject({ id: 'leave-2026-10-22', title: '退社まであと30分（17:40）' });
    expect(new Date(prompts[0].fireAt).getHours()).toBe(17);
    expect(new Date(prompts[0].fireAt).getMinutes()).toBe(10);
    expect(prompts.map((p) => p.id)).not.toContain('leave-2026-10-24');
    expect(leavePrompts({ ...DEFAULT_LEAVE, enabled: false })).toEqual([]);
  });
});
