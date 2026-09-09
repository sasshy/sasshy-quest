import type { Task, WorkStartDay } from './types';

export const WORK_START_DIRECTION = '仕事開始後なるべく早く本着手し、午前に主要作業を進め、午後に余白を作る';

export interface WorkStartMetrics {
  workToContactMin: number | null;
  workToMainMin: number | null;
  contactToMainMin: number | null;
  safeStartStatus: 'within' | 'exceeded' | 'unknown';
}

function parsedTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function minutesBetween(from: string | null, to: string | null): number | null {
  const start = parsedTime(from);
  const end = parsedTime(to);
  if (start === null || end === null || end < start) return null;
  return Math.round((end - start) / 60_000);
}

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function latestSafeStart(deadlineAt: string, remainingEstimateMin: number, bufferMin: number): string {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('実期限を入力してください');
  if (!Number.isFinite(remainingEstimateMin) || remainingEstimateMin < 1) throw new Error('残作業時間は1分以上で入力してください');
  if (!Number.isFinite(bufferMin) || bufferMin < 0) throw new Error('余裕時間は0分以上で入力してください');
  return new Date(deadline - (remainingEstimateMin + bufferMin) * 60_000).toISOString();
}

export function validateWorkStartDay(day: WorkStartDay): string[] {
  const errors: string[] = [];
  const target = parsedTime(day.currentTargetAt);
  const deadline = parsedTime(day.deadlineAt);
  const safe = parsedTime(day.latestSafeStartAt);
  if (!day.anchorText.trim()) errors.push('Morning Anchorを入力してください');
  if (target === null) errors.push('Current Targetを入力してください');
  if (deadline === null) errors.push('実期限を入力してください');
  if (safe === null) errors.push('Latest Safe Startを確認できません');
  if (target !== null && safe !== null && target > safe) errors.push('Current TargetはLatest Safe Start以前にしてください');
  if (safe !== null && deadline !== null && safe > deadline) errors.push('Latest Safe Startは実期限以前にしてください');
  if (day.workStartedAt && parsedTime(day.workStartedAt) === null) errors.push('仕事開始時刻が正しくありません');
  if (day.firstContactAt && parsedTime(day.firstContactAt) === null) errors.push('初回接触時刻が正しくありません');
  if (day.mainStartedAt && parsedTime(day.mainStartedAt) === null) errors.push('本作業開始時刻が正しくありません');
  const work = parsedTime(day.workStartedAt);
  const contact = parsedTime(day.firstContactAt);
  const main = parsedTime(day.mainStartedAt);
  if (work !== null && contact !== null && contact < work) errors.push('初回接触は仕事開始以後にしてください');
  if (work !== null && main !== null && main < work) errors.push('本作業開始は仕事開始以後にしてください');
  if (contact !== null && main !== null && main < contact) errors.push('本作業開始は初回接触以後にしてください');
  return errors;
}

export function workStartMetrics(day: WorkStartDay): WorkStartMetrics {
  const main = parsedTime(day.mainStartedAt);
  const safe = parsedTime(day.latestSafeStartAt);
  return {
    workToContactMin: minutesBetween(day.workStartedAt, day.firstContactAt),
    workToMainMin: minutesBetween(day.workStartedAt, day.mainStartedAt),
    contactToMainMin: minutesBetween(day.firstContactAt, day.mainStartedAt),
    safeStartStatus: main === null || safe === null ? 'unknown' : main > safe ? 'exceeded' : 'within',
  };
}

export function workStartDay(task: Task, dateKey: string): WorkStartDay | null {
  return task.workStartSupport?.version === 1
    ? task.workStartSupport.days[dateKey] || null
    : null;
}

export function workStartTask(tasks: Task[], dateKey: string): Task | null {
  return tasks.find((task) => !task.deletedAt && workStartDay(task, dateKey)?.enabled) || null;
}

export function snoozeTime(day: WorkStartDay, now = new Date()): string | null {
  const safe = parsedTime(day.latestSafeStartAt);
  const next = now.getTime() + 10 * 60_000;
  if (safe === null || now.getTime() >= safe || next >= safe) return null;
  return new Date(next).toISOString();
}

export async function sha256Hex(value: string): Promise<string> {
  if (!value) return '';
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
