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
  if (session.status !== 'completed' || !session.endedAt) return null;
  const started = new Date(session.startedAt).getTime();
  const ended = new Date(session.endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) return null;
  const wallSec = Math.max(0, Math.floor((ended - started) / 1000));
  const activeSec = Math.max(0, wallSec - Math.max(0, session.pausedTotalSec));
  if (activeSec < 30) return null;
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

export function predictDuration(title: string, sessions: FocusSession[], excludeTaskId?: string): DurationPrediction | null {
  const family = taskFamily(title);
  const sameFamily = sessions
    .filter((session) => session.taskId !== excludeTaskId && taskFamily(session.taskTitle) === family)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 12);
  const durations = sameFamily.map(sessionDuration);
  const reliable = durations.flatMap((value) => value?.reliable ? [value.activeMin] : []);
  const ignoredCount = durations.filter((value) => value && !value.reliable).length;
  if (!reliable.length) return null;
  return {
    predictedMin: roundToFive(median(reliable)),
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
