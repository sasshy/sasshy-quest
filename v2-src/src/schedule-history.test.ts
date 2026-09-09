import { describe, expect, it } from 'vitest';
import {
  classifyScheduleOperation,
  effectiveScheduleChanges,
  latestResultsByVersion,
  scheduleSnapshot,
} from './schedule-history';
import type { ScheduleHistoryEntry, ScheduleOperation, Task } from './types';

function task(changes: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '予定',
    notes: '',
    status: 'planned',
    horizon: 'now',
    scheduledDate: '2026-09-08',
    startMinute: 600,
    scheduleVersionId: 'version-1',
    scheduledStartNotification: false,
    durationMin: 25,
    estimateMin: 25,
    importance: 0,
    urgency: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    deletedAt: null,
    source: 'v2',
    sync: { deviceId: 'device-1' },
    ...changes,
  };
}

function entry(
  id: string,
  operation: ScheduleOperation,
  changes: Partial<ScheduleHistoryEntry> = {},
): ScheduleHistoryEntry {
  const snapshot = scheduleSnapshot(task());
  return {
    id,
    taskId: 'task-1',
    operationGroupId: null,
    beforeVersionId: snapshot.scheduleVersionId,
    afterVersionId: snapshot.scheduleVersionId,
    targetVersionId: null,
    operation,
    result: 'unconfirmed',
    before: snapshot,
    after: snapshot,
    title: snapshot.title,
    occurredAt: '2026-09-08T00:00:00.000Z',
    serverReceivedAt: null,
    deviceId: 'device-1',
    source: 'local',
    relatedEntryId: null,
    reason: '',
    ...changes,
  };
}

describe('schedule history helpers', () => {
  it('classifies date, time and duration-only changes separately', () => {
    const before = task();
    expect(classifyScheduleOperation(before, task({ scheduledDate: '2026-09-10' }))).toBe('adjust_date');
    expect(classifyScheduleOperation(before, task({ startMinute: 660 }))).toBe('adjust_time');
    expect(classifyScheduleOperation(before, task({ durationMin: 45 }))).toBe('adjust_duration');
    expect(classifyScheduleOperation(before, task())).toBeNull();
  });

  it('uses the newest non-reverted result and restores it on reapply', () => {
    const first = entry('result-1', 'set_result', {
      targetVersionId: 'version-1',
      result: 'not_done',
      occurredAt: '2026-09-08T00:00:01.000Z',
    });
    const correction = entry('result-2', 'correct_result', {
      targetVersionId: 'version-1',
      result: 'completed',
      occurredAt: '2026-09-08T00:00:02.000Z',
    });
    const revert = entry('revert-1', 'revert', {
      relatedEntryId: correction.id,
      occurredAt: '2026-09-08T00:00:03.000Z',
    });
    expect(latestResultsByVersion([first, correction, revert]).get('version-1')).toBe('not_done');

    const reapply = entry('reapply-1', 'reapply', {
      relatedEntryId: correction.id,
      occurredAt: '2026-09-08T00:00:04.000Z',
    });
    expect(latestResultsByVersion([first, correction, revert, reapply]).get('version-1')).toBe('completed');
  });

  it('keeps append-only controls out of the effective change list', () => {
    const move = entry('move-1', 'adjust_date');
    const revert = entry('revert-1', 'revert', { relatedEntryId: move.id });
    expect(effectiveScheduleChanges([move, revert])).toEqual([]);
  });
});
