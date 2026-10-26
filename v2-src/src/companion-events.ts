/**
 * 相棒のねこに「今これをした」を知らせる（ねこが表示されていれば短い動画で反応する）。
 * 保存の処理から呼ぶので、画面の部品には依存しない。
 */
export type CompanionMoment = 'meal' | 'diary' | 'habit' | 'rest';

export function companionMoment(moment: CompanionMoment): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sasshy-companion', { detail: moment }));
}
