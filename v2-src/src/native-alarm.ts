import type { FocusSession } from './types';

type NativeAlarmAction = 'start' | 'update' | 'updatePaused' | 'pause' | 'resume' | 'cancel';

type NativeAlarmHandler = {
  postMessage: (message: Record<string, unknown>) => void;
};

export interface NativeCoachPrompt {
  id: string;
  fireAt: string;
  title: string;
  body: string;
  spokenText: string;
}

function handler(): NativeAlarmHandler | undefined {
  return (window as unknown as {
    webkit?: { messageHandlers?: { sasshyAlarm?: NativeAlarmHandler } };
  }).webkit?.messageHandlers?.sasshyAlarm;
}

function remainingSeconds(session: FocusSession): number {
  const now = Date.now();
  const startedAt = new Date(session.startedAt).getTime();
  const activePause = session.status === 'paused' && session.pausedAt
    ? Math.max(0, now - new Date(session.pausedAt).getTime())
    : 0;
  const elapsed = Math.max(
    0,
    Math.floor((now - startedAt - session.pausedTotalSec * 1000 - activePause) / 1000),
  );
  return Math.max(1, session.plannedMin * 60 - (session.carriedElapsedSec || 0) - elapsed);
}

export function notifyNativeAlarm(action: NativeAlarmAction, session: FocusSession): void {
  handler()?.postMessage({
    action,
    taskId: session.id,
    title: session.taskTitle,
    remainingSeconds: remainingSeconds(session),
  });
}

export function syncNativeCoach(
  prompts: NativeCoachPrompt[],
  enabled: boolean,
  rate = 1,
  volume = 1,
): boolean {
  const nativeHandler = handler();
  if (!nativeHandler) return false;
  nativeHandler.postMessage({
    action: 'syncCoach',
    enabled,
    rate,
    volume,
    prompts,
  });
  return true;
}
