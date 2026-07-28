import type { VoiceConfig } from './types';

const activeUtterances = new Set<SpeechSynthesisUtterance>();
export const FINAL_COUNTDOWN_SECONDS = [30, 10, 5, 4, 3, 2, 1];

export function announcementThresholds(config: VoiceConfig, plannedMin: number): number[] {
  const minutes = config.announcements.map((minute) => minute * 60);
  const everyMinute = config.everyMinute === false
    ? []
    : Array.from({ length: Math.max(0, Math.floor(plannedMin) - 1) }, (_, index) => (Math.floor(plannedMin) - index - 1) * 60);
  const final = config.finalCountdown === false ? [] : FINAL_COUNTDOWN_SECONDS;
  return [...new Set([...minutes, ...everyMinute, ...final])].filter((seconds) => seconds > 0 && seconds < plannedMin * 60).sort((a, b) => b - a);
}

export function announcementText(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `残り${seconds / 60}分です`;
  if (seconds > 5) return `残り${seconds}秒です`;
  return `${seconds}秒`;
}

export function speakVoice(text: string, config: VoiceConfig): boolean {
  if (!config.enabled || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
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
