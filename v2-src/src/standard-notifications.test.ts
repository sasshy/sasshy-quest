import { describe, expect, it } from 'vitest';
import {
  dueStandardNotificationCandidates,
  standardNotificationCandidates,
  type StoredRecord,
} from '../supabase/functions/sasshy-push/standard-notifications';

function task(payload: Record<string, unknown> = {}): StoredRecord {
  return {
    workspace_hash: 'workspace',
    record_type: 'task',
    id: 'task-1',
    payload: {
      title: '服薬',
      status: 'planned',
      scheduledDate: '2026-09-08',
      startMinute: 9 * 60,
      ...payload,
    },
  };
}

describe('standard push notification policy', () => {
  it('defaults new scheduled task notifications off and keeps explicit ones', () => {
    expect(standardNotificationCandidates(task({ scheduledStartNotification: false }))).toEqual([]);
    expect(standardNotificationCandidates(task({ scheduledStartNotification: true }))[0]?.payload.kind).toBe('task');
  });

  it('temporarily preserves unreviewed legacy scheduled notifications', () => {
    expect(standardNotificationCandidates(task())[0]?.payload.kind).toBe('task');
  });

  it('replaces a scheduled task notification with Phase 1 start support', () => {
    const record = task({
      scheduledStartNotification: true,
      workStartSupport: {
        version: 1,
        days: { '2026-09-08': { enabled: true } },
      },
    });
    expect(standardNotificationCandidates(record)).toEqual([]);
    const stopped = task({
      scheduledStartNotification: true,
      workStartSupport: {
        version: 1,
        days: { '2026-09-08': { enabled: false } },
      },
    });
    expect(standardNotificationCandidates(stopped)).toEqual([]);
  });

  it('creates one timer-end notification without automatic follow-ups', () => {
    const notices = standardNotificationCandidates({
      workspace_hash: 'workspace',
      record_type: 'session',
      id: 'session-1',
      payload: {
        status: 'running',
        startedAt: '2026-09-08T09:00:00+09:00',
        plannedMin: 25,
        taskTitle: '組み立て準備',
      },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.title).toBe('タイマーが終了しました');
    expect(JSON.stringify(notices)).not.toContain('10分たちました');
    expect(JSON.stringify(notices)).not.toContain('タイマーが残っています');
  });

  it('does not notify for paused or completed timers', () => {
    for (const status of ['paused', 'completed'] as const) {
      expect(standardNotificationCandidates({
        workspace_hash: 'workspace',
        record_type: 'session',
        id: `session-${status}`,
        payload: {
          id: `session-${status}`,
          status,
          expectedEndAt: '2026-09-08T00:10:00.000Z',
          taskTitle: '組み立て準備',
        },
      })).toEqual([]);
    }
  });

  it('does not send a standard notification early or after the catch-up window', () => {
    const [notice] = standardNotificationCandidates(task({ scheduledStartNotification: true }));
    expect(dueStandardNotificationCandidates([notice], notice.at - 1)).toEqual([]);
    expect(dueStandardNotificationCandidates([notice], notice.at)).toEqual([notice]);
    expect(dueStandardNotificationCandidates([notice], notice.at + 10 * 60_000 + 1)).toEqual([]);
  });

  it('keeps an explicitly requested memo reminder', () => {
    const notices = standardNotificationCandidates({
      workspace_hash: 'workspace',
      record_type: 'memo',
      id: 'memo-1',
      payload: { title: '服薬', reminderAt: '2026-09-08T09:00:00+09:00' },
    });
    expect(notices[0]?.payload.kind).toBe('memo');
  });
});
