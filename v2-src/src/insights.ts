import type { FocusSession } from './types';

export interface SessionDuration {
  activeMin: number;
  wallMin: number;
  reliable: boolean;
}

export interface DurationPrediction {
  predictedMin: number;
  sampleSize: number;
  ignoredCount: number;
}

export function sessionActiveSeconds(session: FocusSession): number | null {
  if ((session.status !== 'completed' && session.status !== 'interrupted') || !session.endedAt || session.deletedAt) return null;
  const started = new Date(session.startedAt).getTime();
  const ended = new Date(session.endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) return null;
  const wallSec = Math.max(0, Math.floor((ended - started) / 1000));
  const activeSec = Math.max(0, wallSec - Math.max(0, session.pausedTotalSec));
  return activeSec >= 30 ? activeSec : null;
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/[\s　・、。,.()[\]{}「」『』【】/\\_-]+/g, '');
}

export function taskFamily(title: string): string {
  const prefix = title.split(/[：:]/, 1)[0]?.trim() || title;
  const normalizedPrefix = normalizeTitle(prefix);
  if (normalizedPrefix.length >= 2) return normalizedPrefix;
  return normalizeTitle(title).slice(0, 24);
}

export function sessionDuration(session: FocusSession): SessionDuration | null {
  if (!session.endedAt) return null;
  const started = new Date(session.startedAt).getTime();
  const ended = new Date(session.endedAt).getTime();
  const activeSec = sessionActiveSeconds(session);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || activeSec === null) return null;
  const wallSec = Math.max(0, Math.floor((ended - started) / 1000));
  const activeMin = Math.max(1, Math.round(activeSec / 60));
  const wallMin = Math.max(1, Math.round(wallSec / 60));
  const reasonableMax = Math.min(480, Math.max(session.plannedMin * 3, session.plannedMin + 60));
  return { activeMin, wallMin, reliable: activeMin <= reasonableMax };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundToFive(value: number): number {
  return Math.max(5, Math.min(240, Math.round(value / 5) * 5));
}

export function routineEstimateHint(title: string): number | null {
  const normalized = title.normalize('NFKC').toLowerCase().replace(/[\s　]/g, '');
  if (/歯磨き|歯みがき|歯を磨/.test(normalized)) return 5;
  if (/ドライヤー|髪を乾か|髪乾か/.test(normalized)) return 10;
  return null;
}

function reasonableDurationMax(plannedMin: number, title: string): number {
  const routineHint = routineEstimateHint(title);
  if (routineHint) return routineHint * 2;
  if (plannedMin <= 15) return Math.max(plannedMin * 3, plannedMin + 15);
  return Math.min(480, Math.max(plannedMin * 3, plannedMin + 60));
}

export function predictDuration(title: string, sessions: FocusSession[], excludeTaskId?: string): DurationPrediction | null {
  const family = taskFamily(title);
  const routineHint = routineEstimateHint(title);
  const grouped = new Map<string, FocusSession[]>();
  sessions
    .filter((session) => session.taskId !== excludeTaskId && taskFamily(session.taskTitle) === family && !session.deletedAt)
    .forEach((session) => grouped.set(session.taskId, [...(grouped.get(session.taskId) || []), session]));
  const totals = [...grouped.values()]
    .filter((items) => items.some((session) => session.status === 'completed'))
    .map((items) => {
      const seconds = items.reduce((sum, session) => sum + (sessionActiveSeconds(session) || 0), 0);
      const activeMin = Math.max(1, Math.round(seconds / 60));
      const plannedMin = Math.max(...items.map((session) => session.plannedMin), 5);
      const reasonableMax = reasonableDurationMax(plannedMin, items[0]?.taskTitle || title);
      return { activeMin, reliable: seconds >= 30 && activeMin <= reasonableMax, latest: items.map((session) => session.startedAt).sort().at(-1) || '' };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, 12);
  const reliable = totals.flatMap((value) => value.reliable ? [value.activeMin] : []);
  const ignoredCount = totals.filter((value) => !value.reliable).length;
  if (!reliable.length) {
    return routineHint
      ? { predictedMin: routineHint, sampleSize: 0, ignoredCount }
      : null;
  }
  return {
    predictedMin: routineHint
      ? Math.min(routineHint * 2, roundToFive(median(reliable)))
      : roundToFive(median(reliable)),
    sampleSize: reliable.length,
    ignoredCount,
  };
}

export function taskActualDuration(taskId: string, sessions: FocusSession[]): SessionDuration | null {
  const values = sessions
    .filter((session) => session.taskId === taskId)
    .map(sessionDuration)
    .filter((value): value is SessionDuration => Boolean(value));
  if (!values.length) return null;
  return {
    activeMin: values.reduce((sum, value) => sum + value.activeMin, 0),
    wallMin: values.reduce((sum, value) => sum + value.wallMin, 0),
    reliable: values.every((value) => value.reliable),
  };
}

export function taskWorkedSeconds(taskId: string, sessions: FocusSession[]): number {
  return sessions
    .filter((session) => session.taskId === taskId)
    .reduce((sum, session) => sum + (sessionActiveSeconds(session) || 0), 0);
}
