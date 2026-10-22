import { db } from './db';
import type { AppSetting } from './types';
import { localDateKey } from './work-start';

/**
 * Leaving work: a fixed weekday time (e.g. 17:40). From 30 minutes before, the
 * Today screen counts down and offers the 退社前 routine; the iPhone app also
 * gets one notification at that point. Stored on this device.
 */
export interface LeaveSetting { id: 'leaveTime'; enabled: boolean; minute: number }
export const DEFAULT_LEAVE: LeaveSetting = { id: 'leaveTime', enabled: true, minute: 17 * 60 + 40 };
export const LEAVE_LEAD_MIN = 30;

export async function getLeaveSetting(): Promise<LeaveSetting> {
  const saved = (await db.settings.get('leaveTime')) as unknown as Partial<LeaveSetting> | undefined;
  return { ...DEFAULT_LEAVE, ...(saved || {}), id: 'leaveTime' };
}

export async function setLeaveSetting(changes: Partial<Omit<LeaveSetting, 'id'>>): Promise<void> {
  const next = { ...(await getLeaveSetting()), ...changes };
  await db.settings.put(next as unknown as AppSetting);
}

const isWeekday = (date: Date) => date.getDay() !== 0 && date.getDay() !== 6;

/** Minutes until leaving (negative = past it), or null outside the countdown window. */
export function leaveCountdown(setting: LeaveSetting, now = new Date()): number | null {
  if (!setting.enabled || !isWeekday(now)) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const diff = setting.minute - nowMin;
  return diff <= LEAVE_LEAD_MIN && diff >= -180 ? diff : null;
}

export function leavePrompts(setting: LeaveSetting, now = Date.now()) {
  if (!setting.enabled) return [];
  const prompts: { id: string; fireAt: string; title: string; body: string }[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(now + i * 86_400_000);
    if (!isWeekday(day)) continue;
    const fireMin = setting.minute - LEAVE_LEAD_MIN;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(fireMin / 60), fireMin % 60).getTime();
    if (at <= now + 2000) continue;
    const hhmm = `${Math.floor(setting.minute / 60)}:${String(setting.minute % 60).padStart(2, '0')}`;
    prompts.push({ id: `leave-${localDateKey(new Date(at))}`, fireAt: new Date(at).toISOString(), title: `退社まであと${LEAVE_LEAD_MIN}分（${hhmm}）`, body: '退社前ルーティンを始めよう' });
  }
  return prompts;
}
