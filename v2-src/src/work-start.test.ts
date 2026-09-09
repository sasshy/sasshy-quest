import { describe, expect, it } from 'vitest';
import { latestSafeStart, localDateKey, snoozeTime, validateWorkStartDay, workStartMetrics } from './work-start';
import type { WorkStartDay } from './types';

function day(overrides: Partial<WorkStartDay> = {}): WorkStartDay {
  return {
    enabled: true,
    anchorText: '商品を机に出す',
    currentTargetAt: '2026-09-07T04:00:00.000Z',
    reviewOn: '2026-09-14',
    deadlineAt: '2026-09-07T08:00:00.000Z',
    remainingEstimateMin: 60,
    bufferMin: 60,
    latestSafeStartAt: '2026-09-07T06:00:00.000Z',
    workStartedAt: null,
    firstContactAt: null,
    mainStartedAt: null,
    mainStartReportedAt: null,
    mainSessionId: null,
    morningMilestone: '午前分の梱包を終える',
    morningProgress: 'unrecorded',
    progressRecordedAt: null,
    snoozedUntil: null,
    skippedAt: null,
    notificationEndpointHash: '',
    ...overrides,
  };
}

describe('work start support', () => {
  it('calculates the defensive line from the real deadline', () => {
    expect(latestSafeStart('2026-09-07T08:00:00.000Z', 60, 60)).toBe('2026-09-07T06:00:00.000Z');
  });

  it('rejects a current target after the defensive line', () => {
    expect(validateWorkStartDay(day({ currentTargetAt: '2026-09-07T07:00:00.000Z' })))
      .toContain('Current TargetはLatest Safe Start以前にしてください');
  });

  it('keeps missing observations unknown instead of treating them as failure', () => {
    expect(workStartMetrics(day())).toEqual({
      workToContactMin: null,
      workToMainMin: null,
      contactToMainMin: null,
      safeStartStatus: 'unknown',
    });
  });

  it('measures contact and main work separately', () => {
    const metrics = workStartMetrics(day({
      workStartedAt: '2026-09-07T00:00:00.000Z',
      firstContactAt: '2026-09-07T00:05:00.000Z',
      mainStartedAt: '2026-09-07T00:35:00.000Z',
    }));
    expect(metrics.workToContactMin).toBe(5);
    expect(metrics.workToMainMin).toBe(35);
    expect(metrics.contactToMainMin).toBe(30);
    expect(metrics.safeStartStatus).toBe('within');
  });

  it('does not schedule a snooze at or beyond Latest Safe Start', () => {
    expect(snoozeTime(day(), new Date('2026-09-07T05:50:00.000Z'))).toBeNull();
    expect(snoozeTime(day(), new Date('2026-09-07T05:30:00.000Z'))).toBe('2026-09-07T05:40:00.000Z');
  });

  it('uses the device local day as the work-day key', () => {
    expect(localDateKey(new Date(2026, 8, 7, 8))).toBe('2026-09-07');
  });
});
