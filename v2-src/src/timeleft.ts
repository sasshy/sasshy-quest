import { db } from './db';
import type { AppSetting } from './types';

/**
 * 残り時間: how much of today / this week / month / year / until the next
 * birthday is left, plus the user's own countdowns. Stored on this device.
 */
export type TimeLeftKey = 'day' | 'week' | 'month' | 'year' | 'birthday';
export interface Countdown { id: string; label: string; date: string }
export interface TimeLeftSetting {
  id: 'timeLeft';
  enabled: boolean;
  show: Record<TimeLeftKey, boolean>;
  /** YYYY-MM-DD */
  birthday: string;
  /** Minutes from midnight; values over 24h mean after midnight (25:00 = 1am). */
  wakeMinute: number;
  bedMinute: number;
  countdowns: Countdown[];
}

export const DEFAULT_TIME_LEFT: TimeLeftSetting = {
  id: 'timeLeft',
  enabled: true,
  show: { day: true, week: true, month: true, year: true, birthday: true },
  birthday: '1989-12-09',
  wakeMinute: 8 * 60,
  bedMinute: 25 * 60,
  countdowns: [],
};

export async function getTimeLeft(): Promise<TimeLeftSetting> {
  const saved = (await db.settings.get('timeLeft')) as unknown as Partial<TimeLeftSetting> | undefined;
  return { ...DEFAULT_TIME_LEFT, ...(saved || {}), show: { ...DEFAULT_TIME_LEFT.show, ...(saved?.show || {}) }, id: 'timeLeft' };
}

export async function setTimeLeft(changes: Partial<Omit<TimeLeftSetting, 'id'>>): Promise<void> {
  await db.settings.put({ ...(await getTimeLeft()), ...changes } as unknown as AppSetting);
}

export interface TimeLeftItem {
  key: string;
  label: string;
  /** Big number + unit, e.g. "7" "日" */
  value: string;
  unit: string;
  /** Smaller remainder, e.g. "9時間" */
  extra: string;
  note: string;
  /** 0..1 of the period already used */
  used: number;
  /** under 15% left */
  low: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function parseDate(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** "7日 9時間" / "33時間" / "2時間15分" style split of a remaining span. */
export function splitSpan(ms: number): { value: string; unit: string; extra: string } {
  const left = Math.max(0, ms);
  if (left >= 2 * DAY) {
    const days = Math.floor(left / DAY);
    const hours = Math.floor((left - days * DAY) / HOUR);
    return { value: days.toLocaleString('ja-JP'), unit: '日', extra: hours ? `${hours}時間` : '' };
  }
  if (left >= 3 * HOUR) return { value: String(Math.floor(left / HOUR)), unit: '時間', extra: '' };
  const hours = Math.floor(left / HOUR);
  const minutes = Math.floor((left - hours * HOUR) / 60_000);
  return hours
    ? { value: String(hours), unit: '時間', extra: `${minutes}分` }
    : { value: String(minutes), unit: '分', extra: '' };
}

function item(key: string, label: string, start: number, end: number, now: number, note: string): TimeLeftItem {
  const total = Math.max(1, end - start);
  const used = clamp01((now - start) / total);
  return { key, label, ...splitSpan(end - now), note, used, low: 1 - used < 0.15 };
}

const clock = (minute: number) => `${Math.floor((minute % 1440) / 60)}:${String(minute % 60).padStart(2, '0')}`;

/** Age in whole years on a given day. */
export function ageOn(birthday: string, now: Date): number | null {
  const b = parseDate(birthday);
  if (!b) return null;
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age -= 1;
  return age;
}

/** Days lived, counting the birth day as day 1. */
export function daysLived(birthday: string, now: Date): number | null {
  const b = parseDate(birthday);
  if (!b) return null;
  return Math.round((startOfDay(now).getTime() - b.getTime()) / DAY) + 1;
}

export function timeLeftItems(setting: TimeLeftSetting, nowDate = new Date()): TimeLeftItem[] {
  const now = nowDate.getTime();
  const today = startOfDay(nowDate);
  const items: TimeLeftItem[] = [];

  if (setting.show.day) {
    // 起きている時間の残り。日付が変わってから就寝時刻までは「前の日」の続きとして扱う。
    const minuteNow = nowDate.getHours() * 60 + nowDate.getMinutes();
    const base = setting.bedMinute > 1440 && minuteNow < setting.bedMinute - 1440 && minuteNow < setting.wakeMinute ? addDays(today, -1) : today;
    const start = base.getTime() + setting.wakeMinute * 60_000;
    const end = base.getTime() + setting.bedMinute * 60_000;
    const lastBed = addDays(base, -1).getTime() + setting.bedMinute * 60_000;
    if (now < start && now >= lastBed) {
      items.push({ key: 'day', label: '今日', value: '0', unit: '分', extra: '', note: '寝る時間を過ぎています', used: 1, low: true });
    } else {
      items.push(item('day', '今日', start, end, now, `${clock(setting.bedMinute)}に寝るまで`));
    }
  }
  if (setting.show.week) {
    const sinceMonday = (nowDate.getDay() + 6) % 7;
    const start = addDays(today, -sinceMonday);
    items.push(item('week', '今週', start.getTime(), addDays(start, 7).getTime(), now, '日曜の終わりまで'));
  }
  if (setting.show.month) {
    const start = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
    const end = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 1);
    items.push(item('month', '今月', start.getTime(), end.getTime(), now, `${nowDate.getMonth() + 1}月の終わりまで`));
  }
  if (setting.show.year) {
    const start = new Date(nowDate.getFullYear(), 0, 1);
    const end = new Date(nowDate.getFullYear() + 1, 0, 1);
    items.push(item('year', '今年', start.getTime(), end.getTime(), now, `${nowDate.getFullYear()}年の終わりまで`));
  }
  const birth = parseDate(setting.birthday);
  if (setting.show.birthday && birth) {
    let next = new Date(nowDate.getFullYear(), birth.getMonth(), birth.getDate());
    if (next.getTime() <= today.getTime()) next = new Date(nowDate.getFullYear() + 1, birth.getMonth(), birth.getDate());
    const previous = new Date(next.getFullYear() - 1, birth.getMonth(), birth.getDate());
    const turning = next.getFullYear() - birth.getFullYear();
    items.push(item('birthday', `${turning}歳まで`, previous.getTime(), next.getTime(), now, `${next.getMonth() + 1}/${next.getDate()}の誕生日まで`));
  }
  for (const countdown of setting.countdowns) {
    const target = parseDate(countdown.date);
    if (!target) continue;
    const end = addDays(target, 1).getTime();
    if (end <= now) continue;
    // 作った日がわからないので、バーは「残り30日」から減っていく見せ方にする。
    const start = Math.min(now, end - 30 * DAY);
    items.push(item(`c-${countdown.id}`, countdown.label, start, end, now, `${target.getMonth() + 1}/${target.getDate()}まで`));
  }
  return items;
}

/** "25:00" ⇄ 1500. Accepts "1:00" for after-midnight bedtimes when `afterMidnight`. */
export function minuteFromClock(text: string, afterMidnight = false): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minute > 30 * 60) return null;
  return afterMidnight && minute < 12 * 60 ? minute + 1440 : minute;
}

export const clockText = (minute: number) => {
  const m = minute % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
