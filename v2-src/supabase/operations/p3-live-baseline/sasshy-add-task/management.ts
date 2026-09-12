export type TaskSearchStatus = 'open' | 'done' | 'deleted' | 'all';
export type TaskMutationOperation = 'update' | 'complete' | 'reopen' | 'delete' | 'restore';

export interface TaskSearchRequest {
  query?: unknown;
  from_date?: unknown;
  to_date?: unknown;
  status?: unknown;
  include_deleted?: unknown;
  limit?: unknown;
}

export interface ParsedTaskSearchRequest {
  p_query: string;
  p_from_date: string | null;
  p_to_date: string | null;
  p_status: TaskSearchStatus;
  p_include_deleted: boolean;
  p_limit: number;
}

export interface TaskMutationRequest {
  task_id?: unknown;
  revision?: unknown;
  operation?: unknown;
  changes?: unknown;
}

export interface ParsedTaskMutationRequest {
  p_task_id: string;
  p_expected_updated_at: string;
  p_operation: TaskMutationOperation;
  p_patch: Record<string, string | number | null>;
}

const mutationOperations = new Set<TaskMutationOperation>([
  'update',
  'complete',
  'reopen',
  'delete',
  'restore',
]);

function text(value: unknown, field: string, maxLength: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field}が必要です`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field}は文字で指定してください`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field}が必要です`);
  if (result.length > maxLength) throw new Error(`${field}が長すぎます`);
  return result;
}

function validManagementDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function date(value: unknown, field: string): string | null {
  const result = text(value, field, 10);
  if (!result) return null;
  if (!validManagementDate(result)) throw new Error(`${field}はYYYY-MM-DD形式で指定してください`);
  return result;
}

function managementInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field}は${minimum}から${maximum}の整数で指定してください`);
  }
  return Number(value);
}

function optionalBoolean(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') throw new Error(`${field}はtrueかfalseで指定してください`);
  return value;
}

function parseChanges(value: unknown): Record<string, string | number | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('変更内容が必要です');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'title',
    'notes',
    'scheduled_date',
    'start_time',
    'duration_min',
    'importance',
    'urgency',
    'horizon',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`変更できない項目が含まれています: ${key}`);
  }
  if (Object.keys(input).length === 0) throw new Error('変更内容が必要です');

  const output: Record<string, string | number | null> = {};
  if ('title' in input) output.title = text(input.title, 'タイトル', 200, true);
  if ('notes' in input) output.notes = text(input.notes, 'メモ', 4000);
  if ('scheduled_date' in input) {
    if (input.scheduled_date === null || input.scheduled_date === '') output.scheduledDate = null;
    else output.scheduledDate = date(input.scheduled_date, '予定日');
  }
  if ('start_time' in input) {
    if (input.start_time === null || input.start_time === '') {
      output.startMinute = null;
    } else {
      const startTime = text(input.start_time, '開始時刻', 5, true);
      const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(startTime);
      if (!match) throw new Error('開始時刻はHH:MM形式で指定してください');
      output.startMinute = Number(match[1]) * 60 + Number(match[2]);
    }
  }
  if ('duration_min' in input) output.durationMin = managementInteger(input.duration_min, '所要時間', 5, 720);
  if ('importance' in input) output.importance = managementInteger(input.importance, '重要度', 0, 2);
  if ('urgency' in input) output.urgency = managementInteger(input.urgency, '緊急度', 0, 2);
  if ('horizon' in input) {
    const horizon = text(input.horizon, '分類', 16, true);
    if (!['now', 'someday', 'wish', 'waiting'].includes(horizon)) {
      throw new Error('分類の指定が正しくありません');
    }
    output.horizon = horizon;
  }
  return output;
}

export function parseTaskSearchRequest(body: TaskSearchRequest): ParsedTaskSearchRequest {
  const status = body.status === undefined || body.status === null ? 'open' : String(body.status);
  if (!['open', 'done', 'deleted', 'all'].includes(status)) {
    throw new Error('状態の指定が正しくありません');
  }
  const fromDate = date(body.from_date, '開始日');
  const toDate = date(body.to_date, '終了日');
  if (fromDate && toDate && fromDate > toDate) throw new Error('開始日は終了日以前にしてください');
  return {
    p_query: text(body.query, '検索語', 200),
    p_from_date: fromDate,
    p_to_date: toDate,
    p_status: status as TaskSearchStatus,
    p_include_deleted: optionalBoolean(body.include_deleted, '削除済みを含む', false),
    p_limit: body.limit === undefined || body.limit === null
      ? 30
      : managementInteger(body.limit, '取得件数', 1, 100),
  };
}

export function parseTaskMutationRequest(
  body: TaskMutationRequest,
  forcedOperation?: TaskMutationOperation,
): ParsedTaskMutationRequest {
  const operation = forcedOperation || String(body.operation || '');
  if (!mutationOperations.has(operation as TaskMutationOperation)) {
    throw new Error('操作の指定が正しくありません');
  }
  const revision = text(body.revision, '更新番号', 80, true);
  if (Number.isNaN(Date.parse(revision))) throw new Error('更新番号が正しくありません');
  return {
    p_task_id: text(body.task_id, 'タスクID', 200, true),
    p_expected_updated_at: revision,
    p_operation: operation as TaskMutationOperation,
    p_patch: operation === 'update' ? parseChanges(body.changes) : {},
  };
}
