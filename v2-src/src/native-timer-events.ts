import { db } from './db';
import { setFocusSessionPlannedMinutes, stopFocusSessionAt } from './store';
import type { FocusSession } from './types';

/**
 * iPhone app: what the user did on the lock-screen alarm.
 * - stopped:  "ここで止める" (or the alarm was removed) → the timer is paused at that time.
 *             It is never turned into "completed" automatically.
 * - extended: "10分延長" → the timer ends `seconds` after `at`.
 */
export interface NativeTimerEvent {
  id: string;
  type: 'stopped' | 'extended';
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
  const session = await db.sessions.get(event.taskId);
  applied.add(event.id);
  if (!session || session.deletedAt || (session.status !== 'running' && session.status !== 'paused')) return;
  const at = Math.min(now, Math.max(new Date(session.startedAt).getTime(), Date.parse(event.at) || now));
  if (event.type === 'stopped') {
    if (session.status !== 'running') return;
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
