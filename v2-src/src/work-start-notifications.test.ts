import { describe, expect, it } from 'vitest';
import {
  dueWorkStartCandidates,
  hasEnabledWorkStartForDate,
  workStartCandidates,
  type WorkStartRecord,
} from '../supabase/functions/sasshy-push/work-start';

const endpointHash = 'a'.repeat(64);
function record(day: Record<string, unknown> = {}): WorkStartRecord {
  return {
    workspace_hash: 'workspace',
    id: 'task-1',
    payload: {
      title: '出荷',
      scheduledDate: '2026-09-07',
      workStartSupport: {
        version: 1,
        days: {
          '2026-09-07': {
            enabled: true,
            anchorText: '商品を机に出す',
            currentTargetAt: '2026-09-07T04:00:00.000Z',
            latestSafeStartAt: '2026-09-07T06:00:00.000Z',
            notificationEndpointHash: endpointHash,
            ...day,
          },
        },
      },
    },
  };
}

describe('Phase 1 push candidates', () => {
  it('replaces the Current Target with a valid snooze and keeps the defensive line', () => {
    const candidates = workStartCandidates(record({ snoozedUntil: '2026-09-07T04:10:00.000Z' }));
    expect(candidates.map((item) => item.payload.kind)).toEqual(['work-start-snooze', 'work-start-safe']);
  });

  it('stops after main work or a skip is reported', () => {
    expect(workStartCandidates(record({ mainStartReportedAt: '2026-09-07T03:00:00.000Z' }))).toHaveLength(0);
    expect(workStartCandidates(record({ skippedAt: '2026-09-07T03:00:00.000Z' }))).toHaveLength(0);
    expect(workStartCandidates(record({ enabled: false }))).toHaveLength(0);
  });

  it('stops when the task is completed or archived', () => {
    const completed = record();
    completed.payload.status = 'done';
    expect(workStartCandidates(completed)).toHaveLength(0);
    const archived = record();
    archived.payload.status = 'archived';
    expect(workStartCandidates(archived)).toHaveLength(0);
  });

  it('keeps notifying after Anchor contact alone', () => {
    expect(workStartCandidates(record({ firstContactAt: '2026-09-07T03:00:00.000Z' })))
      .toHaveLength(2);
  });

  it('does not create Phase 1 push without one selected endpoint', () => {
    expect(workStartCandidates(record({ notificationEndpointHash: '' }))).toHaveLength(0);
  });

  it('never sends early, gives the defensive line priority, and limits daily attempts to two', () => {
    const candidates = workStartCandidates(record({
      currentTargetAt: '2026-09-07T05:55:00.000Z',
      latestSafeStartAt: '2026-09-07T06:00:00.000Z',
    }));
    expect(dueWorkStartCandidates(candidates, Date.parse('2026-09-07T05:54:59.000Z'), new Map())).toHaveLength(0);
    expect(dueWorkStartCandidates(candidates, Date.parse('2026-09-07T06:00:30.000Z'), new Map())[0]?.payload.kind).toBe('work-start-safe');
    expect(dueWorkStartCandidates(candidates, Date.parse('2026-09-07T06:00:30.000Z'), new Map([['work-start:task-1:2026-09-07', 2]]))).toHaveLength(0);
  });

  it('uses a snooze as the second attempt instead of adding a third defensive-line notice', () => {
    const family = 'work-start:task-1:2026-09-07';
    const snoozed = workStartCandidates(record({ snoozedUntil: '2026-09-07T04:10:00.000Z' }));
    expect(dueWorkStartCandidates(snoozed, Date.parse('2026-09-07T04:10:30.000Z'), new Map([[family, 1]]))[0]?.payload.kind)
      .toBe('work-start-snooze');
    expect(dueWorkStartCandidates(snoozed, Date.parse('2026-09-07T06:00:30.000Z'), new Map([[family, 2]])))
      .toHaveLength(0);
  });

  it('keeps only the latest snooze candidate after repeated saves', () => {
    const first = workStartCandidates(record({ snoozedUntil: '2026-09-07T04:10:00.000Z' }));
    const replaced = workStartCandidates(record({ snoozedUntil: '2026-09-07T04:12:00.000Z' }));
    expect(first.filter((item) => item.payload.kind === 'work-start-snooze')).toHaveLength(1);
    expect(replaced.filter((item) => item.payload.kind === 'work-start-snooze')).toHaveLength(1);
    expect(replaced.find((item) => item.payload.kind === 'work-start-snooze')?.at)
      .toBe(Date.parse('2026-09-07T04:12:00.000Z'));
  });

  it('marks the ordinary scheduled notification for suppression on that day', () => {
    expect(hasEnabledWorkStartForDate(record().payload, '2026-09-07')).toBe(true);
    expect(hasEnabledWorkStartForDate(record().payload, '2026-09-08')).toBe(false);
  });
});
