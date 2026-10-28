import { describe, expect, it } from 'vitest';
import type { Memo, Task } from './types';
import { searchAll } from './search';

const base = { body: '', pinned: false, reminderAt: null, archived: false, deletedAt: null, source: 'v2', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', sync: { deviceId: 'x' } };
const exp = (id: string, item: string, amount: number) => ({ ...base, id, title: item, category: '支出', expense: { at: '2026-10-27T03:00:00.000Z', item, amount } }) as unknown as Memo;
const task = { id: 't1', title: '出荷マニュアルを作る', notes: '', status: 'inbox', scheduledDate: null, deletedAt: null, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' } as unknown as Task;

describe('さがす', () => {
  it('言葉・全角半角・金額で探せる', () => {
    const memos = [exp('a', 'ローソン自由が丘 もちどー', 171), exp('b', 'ファミリーマート カップ麺', 288)];
    expect(searchAll('ﾛｰｿﾝ', [task], memos).map((h) => h.id)).toEqual(['a']);
    expect(searchAll('288円', [task], memos).map((h) => h.id)).toEqual(['b']);
    expect(searchAll('マニュアル', [task], memos)[0].kind).toBe('task');
    expect(searchAll('  ', [task], memos)).toEqual([]);
  });
});
