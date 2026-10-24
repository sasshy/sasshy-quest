import type { VoiceConfig } from './types';

const activeUtterances = new Set<SpeechSynthesisUtterance>();
export const FINAL_COUNTDOWN_SECONDS = [30, 10, 5, 4, 3, 2, 1];

export function announcementThresholds(config: VoiceConfig, plannedMin: number): number[] {
  const minutes = config.announcements.map((minute) => minute * 60);
  const everyHalfMinute = config.everyMinute === false
    ? []
    : Array.from(
        { length: Math.max(0, Math.floor(plannedMin * 2) - 1) },
        (_, index) => (Math.floor(plannedMin * 2) - index - 1) * 30,
      );
  const final = config.finalCountdown === false ? [] : FINAL_COUNTDOWN_SECONDS;
  return [...new Set([...minutes, ...everyHalfMinute, ...final])].filter((seconds) => seconds > 0 && seconds < plannedMin * 60).sort((a, b) => b - a);
}

/** After the planned time, remind every 5 minutes (every 30 seconds was too noisy). */
export const OVERTIME_REMINDER_SECONDS = 5 * 60;

/**
 * The overtime reminder to speak when overtime moved from `previousOvertime` to
 * `overtime` seconds, or null. Only the latest crossed step is returned, so
 * coming back to the app after a long time speaks once, not once per step.
 */
export function overtimeReminderStep(previousOvertime: number, overtime: number, step = OVERTIME_REMINDER_SECONDS): number | null {
  const latest = Math.floor(overtime / step) * step;
  return latest > 0 && latest > previousOvertime ? latest : null;
}

export function announcementText(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `残り${minutes}分${rest}秒です` : `残り${minutes}分です`;
  }
  if (seconds > 5) return `残り${seconds}秒です`;
  return `${seconds}秒`;
}

export function remainingStatusText(seconds: number): string {
  if (seconds <= 0) {
    const overtime = Math.abs(seconds);
    const minutes = Math.floor(overtime / 60);
    const rest = overtime % 60;
    if (minutes === 0) return `${rest}秒オーバーしています`;
    return rest
      ? `${minutes}分${rest}秒オーバーしています`
      : `${minutes}分オーバーしています。続けるか、止めるか決めよう`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `残り${rest}秒です`;
  return `残り${minutes}分${rest ? `${rest}秒` : ''}です`;
}

export function stopVoice(): void {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  activeUtterances.clear();
}

export function speakVoice(text: string, config: VoiceConfig): boolean {
  if (!config.enabled) return false;
  const nativeHandler = (window as Window & {
    webkit?: { messageHandlers?: { sasshyAlarm?: { postMessage: (value: unknown) => void } } };
  }).webkit?.messageHandlers?.sasshyAlarm;
  if (nativeHandler) {
    nativeHandler.postMessage({
      action: 'speak',
      text,
      rate: config.rate,
      volume: config.volume,
      ai: Boolean(config.aiVoice),
    });
    return true;
  }
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.rate = config.rate;
  utterance.volume = config.volume;
  const cleanup = () => activeUtterances.delete(utterance);
  utterance.onend = cleanup;
  utterance.onerror = cleanup;
  activeUtterances.add(utterance);
  window.speechSynthesis.resume();
  window.speechSynthesis.speak(utterance);
  return true;
}
