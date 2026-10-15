import { describe, expect, it } from 'vitest';
import type { VoiceConfig } from './types';
import { announcementText, announcementThresholds, remainingStatusText } from './voice';

const config: VoiceConfig = {
  id: 'voice',
  enabled: true,
  rate: 1,
  volume: 1,
  announcements: [15],
  everyMinute: true,
  finalCountdown: true,
};

describe('voice countdown', () => {
  it('announces every 30 seconds and increasingly often near zero', () => {
    const thresholds = announcementThresholds(config, 7);
    expect(thresholds.slice(0, 4)).toEqual([390, 360, 330, 300]);
    expect(thresholds.slice(-7)).toEqual([30, 10, 5, 4, 3, 2, 1]);
    expect(thresholds).toContain(90);
  });

  it('uses short speech during the final five seconds', () => {
    expect(announcementText(60)).toBe('残り1分です');
    expect(announcementText(90)).toBe('残り1分30秒です');
    expect(announcementText(30)).toBe('残り30秒です');
    expect(announcementText(5)).toBe('5秒');
  });

  it('reports the current time when returning to a timer', () => {
    expect(remainingStatusText(125)).toBe('残り2分5秒です');
    expect(remainingStatusText(30)).toBe('残り30秒です');
    expect(remainingStatusText(-8)).toBe('予定を8秒超過しています');
    expect(remainingStatusText(-90)).toBe('予定を1分30秒超過しています');
  });
});
