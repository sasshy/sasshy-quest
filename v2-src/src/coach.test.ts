import { describe, expect, it } from 'vitest';
import { buildCoachPlan, inferPreparationMinutes } from './coach';
import type { Task, VoiceConfig } from './types';

const voice: VoiceConfig = {
  id: 'voice', enabled: true, coachEnabled: true, defaultPreparationMin: 20,
  rate: 1, volume: 1, announcements: [], everyMinute: true, finalCountdown: true,
};

function task(partial: Partial<Task>): Task {
  return {
    id: '1', title: '資料整理', notes: '', status: 'planned', horizon: 'now',
    scheduledDate: '2026-09-02', startMinute: null, durationMin: 5, estimateMin: 5,
    importance: 0, urgency: 0, createdAt: '', updatedAt: '', completedAt: null,
    deletedAt: null, source: 'v2', sync: { deviceId: 'test' }, ...partial,
  };
}

describe('voice coach', () => {
  it('予定名から準備時間を推測する', () => {
    expect(inferPreparationMinutes('15時から通院')).toBe(60);
    expect(inferPreparationMinutes('Zoom ミーティング')).toBe(10);
    expect(inferPreparationMinutes('自由な予定', 25)).toBe(25);
  });

  it('固定予定前と少なめの確認を最大3件作る', () => {
    const prompts = buildCoachPlan({
      now: new Date(2026, 8, 2, 9, 0),
      tasks: [
        task({ id: 'hospital', title: '通院', startMinute: 15 * 60, isFixed: true }),
        task({ id: 'desk', title: '資料整理' }),
      ],
      voice,
    });
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts.length).toBeLessThanOrEqual(3);
    expect(prompts.some((prompt) => prompt.spokenText.includes('あと60分'))).toBe(true);
  });

  it('夜間の予定前音声は予約しない', () => {
    const prompts = buildCoachPlan({
      now: new Date(2026, 8, 2, 19, 0),
      tasks: [task({ id: 'late', title: '深夜の予定', startMinute: 23 * 60, isFixed: true })],
      voice,
    });
    expect(prompts.some((prompt) => prompt.id.includes('prepare-late'))).toBe(false);
  });
});
