import { db } from './db';
import { getRoutines, startRoutine } from './routines';
import { detourKind, startInterruptAt } from './rounds';
import { setFocusSessionPlannedMinutes, stopFocusSessionAt } from './store';
import { plannedEndMs } from './StaleSession';
import type { FocusSession } from './types';

/**
 * iPhone app: what the user did on the lock-screen alarm.
 * - stopped:  "ここで止める" (or the alarm was removed). Before the planned end the timer
 *             is stopped at that time. At or after the end it only silenced the alarm:
 *             the timer keeps counting the overtime (+) until it is finished in the app.
 *             It is never turned into "completed" automatically.
 * - extended: "10分延長" → the timer ends `seconds` after `at`.
 * - routine:  a widget / Siri shortcut opened sasshy-timer://routine?id=… → start it
 *             (taskId carries the routine id).
 */
export interface NativeTimerEvent {
  id: string;
  type: 'stopped' | 'extended' | 'routine' | 'detour';
  taskId: string; // the session id sent with notifyNativeAlarm
  at: string;
  seconds?: number;
}

const applied = new Set<string>();

function activeSecondsAt(session: FocusSession, at: number): number {
  const pausedNow = session.status === 'paused' && session.pausedAt
    ? Math.max(0, at - new Date(session.pausedAt).getTime())
    : 0;
  return Math.max(0, Math.floor((at - new Date(session.startedAt).getTime() - pausedNow) / 1000) - session.pausedTotalSec)
    + (session.carriedElapsedSec || 0);
}

export async function applyNativeTimerEvent(event: NativeTimerEvent, now = Date.now()): Promise<void> {
  if (applied.has(event.id)) return;
  if (event.type === 'routine') {
    applied.add(event.id);
    // Ignore a stale tap (e.g. queued long ago) and don't stack on a running timer.
    if (now - (Date.parse(event.at) || 0) > 10 * 60_000) return;
    const running = await db.sessions.where('status').anyOf('running', 'paused').filter((s) => !s.deletedAt).count();
    if (running) {
      window.dispatchEvent(new Event('sasshy-open-timer'));
      return;
    }
    const routine = (await getRoutines()).find((r) => r.id === event.taskId);
    if (routine) {
      await startRoutine(routine);
      window.dispatchEvent(new Event('sasshy-open-timer'));
    }
    return;
  }
  if (event.type === 'detour') {
    applied.add(event.id);
    // taskId はアプリ名。3時間より前の記録は今さら区切らない。
    const at = Date.parse(event.at) || now;
    if (now - at > 3 * 60 * 60_000) return;
    const started = await startInterruptAt(detourKind(event.taskId), event.taskId, Math.min(now, at));
    if (started) window.dispatchEvent(new Event('sasshy-open-timer'));
    return;
  }
  const session = await db.sessions.get(event.taskId);
  applied.add(event.id);
  if (!session || session.deletedAt || (session.status !== 'running' && session.status !== 'paused')) return;
  const at = Math.min(now, Math.max(new Date(session.startedAt).getTime(), Date.parse(event.at) || now));
  if (event.type === 'stopped') {
    if (session.status !== 'running') return;
    if (at >= plannedEndMs(session) - 5_000) return;
    await stopFocusSessionAt(session.id, new Date(at).toISOString());
    return;
  }
  if (event.type === 'extended' && event.seconds) {
    const minutes = Math.ceil((activeSecondsAt(session, at) + event.seconds) / 60);
    if (minutes > session.plannedMin) await setFocusSessionPlannedMinutes(session.id, minutes);
  }
}

type Bridge = { postMessage: (message: Record<string, unknown>) => void };

export function startNativeTimerEvents(): void {
  const bridge = (window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: Bridge } } })
    .webkit?.messageHandlers?.sasshyAlarm;
  if (!bridge) return;
  window.addEventListener('sasshy-timer-event', (raw) => {
    const event = (raw as CustomEvent<NativeTimerEvent>).detail;
    if (!event?.id) return;
    applyNativeTimerEvent(event)
      .catch(() => undefined)
      .finally(() => bridge.postMessage({ action: 'timerEventAck', id: event.id }));
  });
  bridge.postMessage({ action: 'timerReady' });
}
