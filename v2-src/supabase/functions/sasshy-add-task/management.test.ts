import { describe, expect, it } from 'vitest';
import { parseTaskMutationRequest, parseTaskSearchRequest } from './management';

describe('task management validation', () => {
  it('parses a bounded open-task search', () => {
    expect(parseTaskSearchRequest({
      query: '出荷',
      from_date: '2026-07-01',
      to_date: '2026-07-31',
      limit: 20,
    })).toEqual({
      p_query: '出荷',
      p_from_date: '2026-07-01',
      p_to_date: '2026-07-31',
      p_status: 'open',
      p_include_deleted: false,
      p_limit: 20,
    });
  });

  it('rejects an inverted date range', () => {
    expect(() => parseTaskSearchRequest({
      from_date: '2026-08-01',
      to_date: '2026-07-01',
    })).toThrow('開始日は終了日以前');
  });

  it('converts safe update fields to the stored task shape', () => {
    expect(parseTaskMutationRequest({
      task_id: 'task-123',
      revision: '2026-07-30T01:00:00.000Z',
      operation: 'update',
      changes: {
        scheduled_date: '2026-08-01',
        start_time: '09:30',
        duration_min: 40,
      },
    })).toEqual({
      p_task_id: 'task-123',
      p_expected_updated_at: '2026-07-30T01:00:00.000Z',
      p_operation: 'update',
      p_patch: {
        scheduledDate: '2026-08-01',
        startMinute: 570,
        durationMin: 40,
      },
    });
  });

  it('allows clearing a task date and time', () => {
    expect(parseTaskMutationRequest({
      task_id: 'task-123',
      revision: '2026-07-30T01:00:00.000Z',
      changes: { scheduled_date: null, start_time: null },
    }, 'update').p_patch).toEqual({
      scheduledDate: null,
      startMinute: null,
    });
  });

  it('rejects fields outside the update allowlist', () => {
    expect(() => parseTaskMutationRequest({
      task_id: 'task-123',
      revision: '2026-07-30T01:00:00.000Z',
      operation: 'update',
      changes: { deletedAt: 'now' },
    })).toThrow('変更できない項目');
  });

  it('requires a revision for destructive operations', () => {
    expect(() => parseTaskMutationRequest({
      task_id: 'task-123',
      operation: 'delete',
    })).toThrow('更新番号が必要');
  });
});
