import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './voice-command';

describe('声で操作', () => {
  it('understands extend / pause / resume / complete', () => {
    expect(parseVoiceCommand('あと5分')).toEqual({ kind: 'extend', minutes: 5 });
    expect(parseVoiceCommand('あと十分延長して')).toEqual({ kind: 'extend', minutes: 10 });
    expect(parseVoiceCommand('もうちょい')).toEqual({ kind: 'extend', minutes: 5 });
    expect(parseVoiceCommand('止めて')).toEqual({ kind: 'pause' });
    expect(parseVoiceCommand('再開')).toEqual({ kind: 'resume' });
    expect(parseVoiceCommand('終わった')).toEqual({ kind: 'complete' });
    expect(parseVoiceCommand('今日の天気')).toMatchObject({ kind: 'unknown' });
  });
});
