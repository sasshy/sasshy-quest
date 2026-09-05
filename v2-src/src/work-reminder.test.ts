import { describe, expect, it } from 'vitest';
import { workReminderSlot } from '../supabase/functions/_shared/work-reminder';
const at = (s: string) => Date.parse(s + '+09:00');
const task = { reminderEnabled: true, dueDate: '2026-09-07', dueTime: '10:30', status: 'inbox', createdAt: '2026-09-05T10:00:00Z' };
describe('unhandled work notifications', () => {
  it('does not send early and keeps one key for each hourly slot', () => {
    expect(workReminderSlot(task, at('2026-09-07T10:29:59'))).toBeNull();
    expect(workReminderSlot(task, at('2026-09-07T10:31:00'))).toBe(at('2026-09-07T10:30:00'));
    expect(workReminderSlot(task, at('2026-09-07T11:29:00'))).toBe(at('2026-09-07T10:30:00'));
    expect(workReminderSlot(task, at('2026-09-07T11:31:00'))).toBe(at('2026-09-07T11:30:00'));
  });
  it('suppresses nights and weekends and catches up once on the next workday', () => {
    for (const time of ['2026-09-07T18:00:00', '2026-09-08T08:59:00', '2026-09-12T10:00:00']) expect(workReminderSlot(task, at(time))).toBeNull();
    expect(workReminderSlot(task, at('2026-09-14T09:22:00'))).toBe(at('2026-09-14T09:00:00'));
  });
  it('stops on handling, deletion, disable and snooze', () => {
    const now = at('2026-09-07T12:00:00');
    for (const status of ['done', 'archived', 'active']) expect(workReminderSlot({ ...task, status }, now)).toBeNull();
    expect(workReminderSlot({ ...task, deletedAt: new Date().toISOString() }, now)).toBeNull();
    expect(workReminderSlot({ ...task, reminderEnabled: false }, now)).toBeNull();
    expect(workReminderSlot({ ...task, reminderAfter: '2026-09-08T09:00:00+09:00' }, now)).toBeNull();
  });
  it('defaults missing deadline times to 17:00, missing dates to creation +1h, and legacy tasks off', () => {
    expect(workReminderSlot({ ...task, dueTime: null }, at('2026-09-07T16:59:00'))).toBeNull();
    expect(workReminderSlot({ ...task, dueTime: null }, at('2026-09-07T17:01:00'))).toBe(at('2026-09-07T17:00:00'));
    expect(workReminderSlot({ reminderEnabled: true, createdAt: '2026-09-07T09:15:00+09:00' }, at('2026-09-07T10:16:00'))).toBe(at('2026-09-07T10:15:00'));
    expect(workReminderSlot({}, at('2026-09-07T12:00:00'))).toBeNull();
  });
});
