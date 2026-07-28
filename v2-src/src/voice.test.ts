import { describe, expect, it } from 'vitest';
import type { VoiceConfig } from './types';
import { announcementText, announcementThresholds } from './voice';

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
  it('announces every minute and increasingly often near zero', () => {
    expect(announcementThresholds(config, 7)).toEqual([360, 300, 240, 180, 120, 60, 30, 10, 5, 4, 3, 2, 1]);
  });

  it('uses short speech during the final five seconds', () => {
    expect(announcementText(60)).toBe('残り1分です');
    expect(announcementText(30)).toBe('残り30秒です');
    expect(announcementText(5)).toBe('5秒');
  });
});
