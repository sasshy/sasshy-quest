import { describe, expect, it } from 'vitest';
import { createTaskLink, parseTaskLink, type TaskLinkPayload } from './task-link';

describe('Codex task links', () => {
  it('round trips a Japanese task with its schedule', () => {
    const payload: TaskLinkPayload = {
      v: 1,
      requestId: 'codex-20260813-001',
      title: '野田さんにSG50の件で電話',
      notes: '交換後の状態を確認する',
      scheduledDate: '2026-08-14',
      startTime: '10:30',
      durationMin: 10,
      importance: 1,
      urgency: 0,
      horizon: 'now',
    };
    const result = parseTaskLink(createTaskLink('https://example.com/v2/', payload));

    expect(result.error).toBe('');
    expect(result.task).toMatchObject({
      requestId: payload.requestId,
      title: payload.title,
      notes: payload.notes,
      scheduledDate: payload.scheduledDate,
      startMinute: 10 * 60 + 30,
      durationMin: 10,
      importance: 1,
      horizon: 'now',
    });
  });

  it('rejects malformed dates and times', () => {
    const url = createTaskLink('https://example.com/v2/', {
      v: 1,
      requestId: 'codex-invalid-date',
      title: '壊れた予定',
      scheduledDate: '2026-02-30',
      startTime: '25:00',
    });

    expect(parseTaskLink(url).task).toBeNull();
    expect(parseTaskLink(url).error).toContain('予定日');
  });

  it('does not treat a regular app URL as an import', () => {
    expect(parseTaskLink('https://example.com/v2/?open=today')).toEqual({
      hasTask: false,
      task: null,
      error: '',
    });
  });
});
