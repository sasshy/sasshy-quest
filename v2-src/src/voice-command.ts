/**
 * 声で操作（タイマー中）: the iPhone listens a few seconds on the device and
 * hands the words here. Only a few clear commands; anything else is shown back.
 */
export type VoiceCommand =
  | { kind: 'extend'; minutes: number }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'complete' }
  | { kind: 'unknown'; text: string };

const KANJI: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十五: 15, 二十: 20, 三十: 30 };

export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = raw.normalize('NFKC').replace(/\s+/g, '');
  const minutes = /(\d{1,3}|十五|二十|三十|[一二三四五六七八九十])分/.exec(text);
  if (minutes && /(あと|延長|伸ば|のば|足し|たし|追加)/.test(text)) {
    const n = /\d/.test(minutes[1]) ? Number(minutes[1]) : KANJI[minutes[1]];
    if (n > 0 && n <= 120) return { kind: 'extend', minutes: n };
  }
  if (/(延長|伸ばして|のばして|もうちょい|もう少し)/.test(text)) return { kind: 'extend', minutes: 5 };
  if (/(再開|続き|つづき|スタート)/.test(text)) return { kind: 'resume' };
  if (/(止め|とめ|一時停止|ストップ|休憩|待って)/.test(text)) return { kind: 'pause' };
  if (/(完了|終わった|おわった|終わり|できた|終了)/.test(text)) return { kind: 'complete' };
  return { kind: 'unknown', text: raw };
}

type Bridge = { postMessage: (value: unknown) => void };
const bridge = () => (window as unknown as { webkit?: { messageHandlers?: { sasshyAlarm?: Bridge } } }).webkit?.messageHandlers?.sasshyAlarm;

export const canListen = () => Boolean(bridge());

/** Ask the iPhone to listen; resolves with what was heard (or an error message). */
export function listenOnce(): Promise<{ text: string; error: string }> {
  return new Promise((resolve) => {
    const handler = bridge();
    if (!handler) return resolve({ text: '', error: 'iPhoneアプリでだけ使えます' });
    const done = (event: Event) => {
      window.removeEventListener('sasshy-voice-command', done);
      const d = (event as CustomEvent<{ text?: string; error?: string }>).detail || {};
      resolve({ text: d.text || '', error: d.error || '' });
    };
    window.addEventListener('sasshy-voice-command', done);
    handler.postMessage({ action: 'listen' });
  });
}
