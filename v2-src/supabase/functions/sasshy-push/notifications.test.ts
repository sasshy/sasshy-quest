import { describe, expect, it } from 'vitest';
import { candidates } from './notifications';
const now = Date.parse('2026-09-07T11:30:00+09:00');
describe('dispatcher candidates', () => {
  it('includes recurring work candidates without changing existing timer followups', () => {
    const notices = candidates({ workspace_hash: 'test', record_type: 'task', id: '1', payload: { title: '仕事', status: 'inbox', reminderEnabled: true, dueDate: '2026-09-07', dueTime: '10:30' } }, now);
    expect(notices.map(n => n.payload.kind)).toEqual(['work']);
    const timers = candidates({ workspace_hash: 'test', record_type: 'session', id: '2', payload: { status: 'running', startedAt: '2026-09-07T10:00:00+09:00', plannedMin: 25 } }, now);
    expect(timers.map(n => n.at)).toEqual([25,35,55].map(min => Date.parse('2026-09-07T10:00:00+09:00') + min * 60_000));
  });
  it('does not treat unscheduled task time as midnight, retains memo reminders', () => {
    expect(candidates({ workspace_hash:'test',record_type:'task',id:'1',payload:{ scheduledDate:'2026-09-07',startMinute:null } }, now)).toEqual([]);
    expect(candidates({ workspace_hash:'test',record_type:'memo',id:'2',payload:{ reminderAt: new Date(now).toISOString() } }, now)[0].payload.kind).toBe('memo');
  });
});
