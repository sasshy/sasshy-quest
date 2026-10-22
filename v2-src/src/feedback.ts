import { appearanceNow } from './appearance';

/**
 * Small physical rewards. Haptics go to the iPhone app (no-op in the browser);
 * the completion sound is synthesized with Web Audio (respects the sound setting).
 */
type Haptic = 'tap' | 'start' | 'tick' | 'success' | 'levelUp';

export function haptic(kind: Haptic): void {
  const bridge = (window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: { postMessage: (m: unknown) => void } } } })
    .webkit?.messageHandlers?.sasshyAlarm;
  bridge?.postMessage({ action: 'haptic', kind });
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx = ctx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

function tone(c: AudioContext, freq: number, at: number, length: number, gain: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(g).connect(c.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** Two rising notes, ~0.35 s. `force` plays even when sound is off (settings preview). */
export function playDone(force = false): void {
  if (!force && !appearanceNow().sound) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  tone(c, 784, t, 0.18, 0.18);
  tone(c, 1175, t + 0.09, 0.26, 0.16);
}

export function playStart(): void {
  if (!appearanceNow().sound) return;
  const c = audio();
  if (!c) return;
  tone(c, 523, c.currentTime + 0.01, 0.12, 0.1);
}

export function playLevelUp(): void {
  if (!appearanceNow().sound) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  [659, 784, 988, 1319].forEach((f, i) => tone(c, f, t + i * 0.08, 0.22, 0.14));
}
