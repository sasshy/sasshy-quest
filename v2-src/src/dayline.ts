import { localDateKey } from './work-start';

/**
 * 1日の区切りは夜中4時。0時を過ぎてからやった夜ルーティンや片付けも
 * 「その夜（前の日）」の分として数える。
 */
export const DAY_LINE_HOURS = 4;

export function workDayKey(at: string | number | Date): string {
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  return localDateKey(new Date(t - DAY_LINE_HOURS * 3_600_000));
}

/** その日の0時から数えた分（夜中なら24時を越えて 24:30 = 1470 のようになる）。 */
export function minuteFrom(dateKey: string, at: string | number | Date): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  return Math.round((t - new Date(y, m - 1, d).getTime()) / 60_000);
}
