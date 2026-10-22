import { db } from './db';
import type { AppSetting, Task } from './types';
import { localDateKey } from './work-start';

/**
 * Three fixed moments a day, nothing more (too many notifications get ignored):
 * - morning (weekdays): "今日の1つ目は〇〇"
 * - lunch: handled by the meal reminder (now also shows 今日あと使える)
 * - night: "夜ルーティン始める？"
 * Stored on this device; times are editable in the routine editor.
 */
export interface NudgeSetting { id: 'nudges'; enabled: boolean; morning: number; night: number }
export const DEFAULT_NUDGES: NudgeSetting = { id: 'nudges', enabled: true, morning: 9 * 60, night: 21 * 60 + 30 };

export async function getNudges(): Promise<NudgeSetting> {
  const saved = (await db.settings.get('nudges')) as unknown as Partial<NudgeSetting> | undefined;
  return { ...DEFAULT_NUDGES, ...(saved || {}), id: 'nudges' };
}

export async function setNudges(changes: Partial<Omit<NudgeSetting, 'id'>>): Promise<void> {
  await db.settings.put({ ...(await getNudges()), ...changes } as unknown as AppSetting);
}

const at = (day: Date, minute: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60).getTime();

function firstTaskOn(tasks: Task[], key: string): Task | undefined {
  return tasks
    .filter((t) => !t.deletedAt && t.status !== 'done' && t.scheduledDate === key)
    .sort((a, b) => (a.flowOrder ?? 9999) - (b.flowOrder ?? 9999) || (a.startMinute ?? 9999) - (b.startMinute ?? 9999))[0];
}

export function nudgePrompts(tasks: Task[], setting: NudgeSetting, now = Date.now()) {
  if (!setting.enabled) return [];
  const prompts: { id: string; fireAt: string; title: string; body: string }[] = [];
  for (let i = 0; i < 3; i += 1) {
    const day = new Date(now + i * 86_400_000);
    const key = localDateKey(day);
    const weekday = day.getDay() !== 0 && day.getDay() !== 6;
    const morning = at(day, setting.morning);
    if (weekday && morning > now + 2000) {
      const first = firstTaskOn(tasks, key);
      prompts.push({
        id: `nudge-morning-${key}`,
        fireAt: new Date(morning).toISOString(),
        title: first ? `今日の1つ目：${first.title}` : '今日の1つ目を決めよう',
        body: first ? `${first.estimateMin}分だけ。開いて「開始」を押すだけ` : 'SASSHYを開いて、やることを1つ入れる',
      });
    }
    const night = at(day, setting.night);
    if (night > now + 2000) {
      prompts.push({ id: `nudge-night-${key}`, fireAt: new Date(night).toISOString(), title: '夜ルーティン始める？', body: 'シャワーから。開いて「夜ルーティン」を押すだけ' });
    }
  }
  return prompts;
}
