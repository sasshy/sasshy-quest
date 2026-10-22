import { liveQuery } from 'dexie';
import { db } from './db';
import type { AppSetting } from './types';

/**
 * Look and feel, stored on this device:
 * - font: 1 = system (Hiragino), 2 = Outfit numbers, 3 = Space Grotesk + Zen Kaku Gothic (default)
 * - sound: short completion sound (vibration is always on in the iPhone app)
 * - accent: the one color used for "press here"; more unlock with level
 */
export type FontChoice = 1 | 2 | 3;
export type Accent = 'purple' | 'blue' | 'orange' | 'green' | 'gold';
export interface Appearance { id: 'appearance'; font: FontChoice; sound: boolean; accent: Accent; dailyGoalMin: number }
export const DEFAULT_APPEARANCE: Appearance = { id: 'appearance', font: 3, sound: true, accent: 'purple', dailyGoalMin: 60 };

/** Level needed to use each accent. */
export const ACCENT_UNLOCK: Record<Accent, number> = { purple: 1, blue: 3, orange: 5, green: 7, gold: 10 };
export const ACCENT_LABEL: Record<Accent, string> = { purple: '紫', blue: '青', orange: 'オレンジ', green: '緑', gold: 'ゴールド' };
export const FONT_LABEL: Record<FontChoice, string> = { 1: '標準（ヒラギノ）', 2: 'Outfit（丸み）', 3: 'Space Grotesk（スタイリッシュ）' };

export async function getAppearance(): Promise<Appearance> {
  const saved = (await db.settings.get('appearance')) as unknown as Partial<Appearance> | undefined;
  return { ...DEFAULT_APPEARANCE, ...(saved || {}), id: 'appearance' };
}

export async function setAppearance(changes: Partial<Omit<Appearance, 'id'>>): Promise<void> {
  await db.settings.put({ ...(await getAppearance()), ...changes } as unknown as AppSetting);
}

let current: Appearance = DEFAULT_APPEARANCE;
export const appearanceNow = () => current;

function apply(a: Appearance): void {
  current = a;
  const root = document.documentElement;
  root.dataset.font = String(a.font);
  root.dataset.accent = a.accent;
}

/** Apply now (defaults) and whenever the setting changes. */
export function startAppearance(): void {
  apply(DEFAULT_APPEARANCE);
  liveQuery(() => getAppearance()).subscribe({ next: apply, error: () => undefined });
}
