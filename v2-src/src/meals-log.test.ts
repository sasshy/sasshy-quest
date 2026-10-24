import { describe, expect, it } from 'vitest';
import { mealsCsv } from './MealsLog';
import type { Memo } from './types';

describe('食事のCSV', () => {
  it('writes one line per meal with nutrition and quotes commas', () => {
    const memo = { id: 'memo-1', category: '食事', deletedAt: null, archived: false, meal: { kind: 'dinner', item: '肉じゃが, 大盛り', price: null, at: '2026-10-24T10:30:00Z', kcal: 520, protein: 20, payment: 'home', place: '家' } } as unknown as Memo;
    const lines = mealsCsv([memo]).split('\n');
    expect(lines[0]).toContain('kcal');
    expect(lines[1]).toContain('"肉じゃが, 大盛り"');
    expect(lines[1]).toContain('520');
    expect(lines[1]).toContain('家で食べた');
  });
});
