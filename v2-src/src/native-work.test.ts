import { describe, expect, it } from 'vitest';
import { buildWorkPrompts } from './native-work';
import type { Task } from './types';
const base = { id: 'voice-1', title: '見積送付', counterparty: 'A社', status: 'inbox', reminderEnabled: true, createdAt: '2026-09-04T00:00:00Z', dueDate: '2026-09-07', dueTime: '15:00' } as Task;
describe('iPhone work notification reservations', () => {
  it('reserves JST weekdays hourly at the due time and preserves task identity', () => {
    const result = buildWorkPrompts([base], Date.parse('2026-09-07T14:59:00+09:00'));
    expect(result[0].fireAt).toBe('2026-09-07T06:00:00.000Z');
    expect(result[1].fireAt).toBe('2026-09-07T07:00:00.000Z');
    expect(result[0].body).toBe('見積送付／A社');
    expect(new Set(result.map(p => p.id)).size).toBe(result.length);
  });
  it('stops for started, completed, deleted and disabled tasks', () => {
    for (const patch of [{status:'active'}, {status:'done'}, {status:'archived'}, {deletedAt:'2026-09-07'}, {reminderEnabled:false}]) {
      expect(buildWorkPrompts([{...base, ...patch} as Task], Date.parse('2026-09-07T00:00:00Z'))).toEqual([]);
    }
  });
  it('honors snooze across a weekend', () => {
    const result = buildWorkPrompts([{...base, dueDate:'2026-09-04', reminderAfter:'2026-09-05T15:00:00+09:00'}], Date.parse('2026-09-04T17:30:00+09:00'));
    expect(result[0].fireAt).toBe('2026-09-07T00:00:00.000Z');
  });
  it('bounds the global queue and keeps all reservations in business hours', () => {
    const result = buildWorkPrompts(Array.from({length:20}, (_,i)=>({...base,id:String(i)})), Date.parse('2026-09-07T14:59:00+09:00'));
    expect(result).toHaveLength(48);
    for (const prompt of result) {
      const jst = new Date(Date.parse(prompt.fireAt)+9*3600000);
      expect(jst.getUTCHours()).toBeGreaterThanOrEqual(9);
      expect(jst.getUTCHours()).toBeLessThan(18);
      expect([0,6]).not.toContain(jst.getUTCDay());
    }
  });
  it('does not schedule legacy tasks and malformed dates', () => {
    expect(buildWorkPrompts([{...base, reminderEnabled:undefined},{...base,dueDate:'bad'}])).toEqual([]);
  });
});
