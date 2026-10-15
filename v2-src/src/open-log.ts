import { db } from './db';

/**
 * Counts how often SASSHY is brought to the front, per local day, on this device only
 * (never synced). Baseline for the "open SASSHY more often" experiment.
 * Re-opens within 2 minutes count once.
 */
const KEY = 'openLog';
const GAP_MS = 2 * 60_000;
const KEEP_DAYS = 90;

export interface OpenLog { id: typeof KEY; days: Record<string, number>; lastAt: number }

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addOpen(log: OpenLog | undefined, at: number): OpenLog {
  const current: OpenLog = log ?? { id: KEY, days: {}, lastAt: 0 };
  if (at - current.lastAt < GAP_MS) return current;
  const days = { ...current.days, [dayKey(at)]: (current.days[dayKey(at)] || 0) + 1 };
  const kept = Object.keys(days).sort().slice(-KEEP_DAYS);
  return { id: KEY, days: Object.fromEntries(kept.map((k) => [k, days[k]])), lastAt: at };
}

export async function recordOpen(at = Date.now()): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const log = (await db.settings.get(KEY)) as unknown as OpenLog | undefined;
    const next = addOpen(log, at);
    if (next !== log) await db.settings.put(next as unknown as import('./types').AppSetting);
  });
}

export function startOpenLog(): void {
  void recordOpen().catch(() => undefined);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void recordOpen().catch(() => undefined);
  });
}
