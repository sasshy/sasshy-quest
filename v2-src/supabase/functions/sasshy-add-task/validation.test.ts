import { describe, expect, it } from 'vitest';
import { parseTaskRequest } from './validation';

describe('parseTaskRequest', () => {
  it('trims text and converts time to minutes', () => {
    expect(parseTaskRequest({
      idempotency_key: 'request-1234',
      title: '  発注メールを作る  ',
      notes: '  取引先A  ',
      scheduled_date: '2026-07-31',
      start_time: '09:05',
      duration_min: 10,
      importance: 1,
      urgency: 2,
    })).toEqual({
      p_idempotency_key: 'request-1234',
      p_title: '発注メールを作る',
      p_notes: '取引先A',
      p_horizon: 'now',
      p_scheduled_date: '2026-07-31',
      p_start_minute: 545,
      p_duration_min: 10,
      p_importance: 1,
      p_urgency: 2,
    });
  });

  it('uses safe defaults for an unscheduled task', () => {
    const parsed = parseTaskRequest({
      idempotency_key: 'request-5678',
      title: 'あとで確認',
    });
    expect(parsed.p_scheduled_date).toBeNull();
    expect(parsed.p_start_minute).toBeNull();
    expect(parsed.p_duration_min).toBe(25);
    expect(parsed.p_horizon).toBe('now');
  });

  it.each([
    [{ idempotency_key: 'short', title: 'x' }, '受付番号'],
    [{ idempotency_key: 'request-1234', title: '' }, 'タイトル'],
    [{ idempotency_key: 'request-1234', title: 'x', scheduled_date: '2026-02-30' }, '予定日'],
    [{ idempotency_key: 'request-1234', title: 'x', start_time: '09:00' }, '予定日'],
    [{ idempotency_key: 'request-1234', title: 'x', scheduled_date: '2026-07-31', start_time: '24:00' }, 'HH:MM'],
    [{ idempotency_key: 'request-1234', title: 'x', duration_min: 4 }, '所要時間'],
    [{ idempotency_key: 'request-1234', title: 'x', importance: 3 }, '重要度'],
    [{ idempotency_key: 'request-1234', title: 'x', horizon: 'later' }, '分類'],
  ])('rejects invalid input %#', (input, message) => {
    expect(() => parseTaskRequest(input)).toThrow(message);
  });
});
