import { describe, expect, it, vi } from 'vitest';
import { parseVoiceInput, parseVoiceTask, extractVoiceTask } from './voice';
const task = { title: '見積を送る', dueDate: '2026-09-07', dueTime: '15:00', counterparty: '南出キカイ', requestSource: '善之さん／電話', notes: '部品の金額を確認' };
describe('voice intake', () => {
  it('validates input and retains original Japanese text', () => {
    expect(parseVoiceInput({ idempotency_key: 'voice-1234', transcript: ' 明日までに見積 ' }).transcript).toBe('明日までに見積');
    for (const body of [null, [], {}, { idempotency_key: 'voice-1234', transcript: ' ' }, { idempotency_key: 'voice-1234', transcript: 'a'.repeat(4001) }]) expect(() => parseVoiceInput(body)).toThrow();
  });
  it('rejects impossible dates, missing fields and ungrounded time-only deadlines', () => {
    expect(parseVoiceTask(task)).toEqual(task);
    for (const patch of [{ dueDate: '2026-02-30' }, { dueTime: '24:00' }, { dueDate: null }, { title: '' }, { counterparty: 42 }]) expect(() => parseVoiceTask({ ...task, ...patch })).toThrow();
    expect(parseVoiceTask({ ...task, dueDate: null, dueTime: null }).dueDate).toBeNull();
  });
  it('requires successful complete structured AI output before returning a task', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(task) } }] })));
    expect(await extractVoiceTask('依頼', 'fake-test-key', 'test-model', new Date('2026-09-05T15:30:00Z'), fetcher)).toEqual(task);
    const request = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(request.store).toBe(false);
    expect(request.messages[0].content).toContain('2026');
    fetcher.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(extractVoiceTask('依頼', 'fake-test-key', 'test-model', new Date(), fetcher)).rejects.toThrow();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(task) } }] })));
    await expect(extractVoiceTask('依頼', 'fake-test-key', 'test-model', new Date(), fetcher)).rejects.toThrow();
  });
});
