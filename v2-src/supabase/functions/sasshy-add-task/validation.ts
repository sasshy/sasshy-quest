export interface AddTaskRequest {
  idempotency_key?: unknown;
  title?: unknown;
  notes?: unknown;
  scheduled_date?: unknown;
  start_time?: unknown;
  duration_min?: unknown;
  importance?: unknown;
  urgency?: unknown;
  horizon?: unknown;
}

export interface ParsedTaskRequest {
  p_idempotency_key: string;
  p_title: string;
  p_notes: string;
  p_horizon: string;
  p_scheduled_date: string | null;
  p_start_minute: number | null;
  p_duration_min: number;
  p_importance: number;
  p_urgency: number;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field}は文字で指定してください`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${field}が長すぎます`);
  return result;
}

function integer(value: unknown, field: string, defaultValue: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field}は${minimum}から${maximum}の整数で指定してください`);
  }
  return Number(value);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function parseStartMinute(value: unknown, hasDate: boolean): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!hasDate) throw new Error('開始時刻を指定するときは予定日も必要です');
  if (typeof value !== 'string') throw new Error('開始時刻はHH:MM形式で指定してください');
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error('開始時刻はHH:MM形式で指定してください');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseTaskRequest(body: AddTaskRequest): ParsedTaskRequest {
  const idempotencyKey = optionalText(body.idempotency_key, '受付番号', 128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new Error('受付番号は8文字以上の英数字で指定してください');
  }

  const title = optionalText(body.title, 'タイトル', 200);
  if (!title) throw new Error('タイトルが必要です');

  const notes = optionalText(body.notes, 'メモ', 4000);
  const scheduledDate = optionalText(body.scheduled_date, '予定日', 10);
  if (scheduledDate && !validDate(scheduledDate)) throw new Error('予定日はYYYY-MM-DD形式で指定してください');

  const horizon = body.horizon === undefined || body.horizon === null ? 'now' : body.horizon;
  if (!['now', 'someday', 'wish', 'waiting'].includes(String(horizon))) {
    throw new Error('分類の指定が正しくありません');
  }

  return {
    p_idempotency_key: idempotencyKey,
    p_title: title,
    p_notes: notes,
    p_horizon: String(horizon),
    p_scheduled_date: scheduledDate || null,
    p_start_minute: parseStartMinute(body.start_time, Boolean(scheduledDate)),
    p_duration_min: integer(body.duration_min, '所要時間', 25, 5, 720),
    p_importance: integer(body.importance, '重要度', 0, 0, 2),
    p_urgency: integer(body.urgency, '緊急度', 0, 0, 2),
  };
}
