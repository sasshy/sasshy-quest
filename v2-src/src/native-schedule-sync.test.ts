import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensureDefaults } from './db';
import { createTask } from './store';
import { saveSyncConfig, syncNow } from './sync';
import type { Task } from './types';

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(async () => {
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { sasshyAlarm: { postMessage: () => undefined } } };
  await db.open();
  await Promise.all([db.tasks.clear(), db.outbox.clear(), db.scheduleOutbox.clear(), db.scheduleHistory.clear(), db.history.clear(), db.settings.clear()]);
  await ensureDefaults();
  await saveSyncConfig({ enabled: true, url: 'https://example.supabase.co', apiKey: 'sb_publishable_test', syncKey: 'sync-test' });
});

afterEach(() => {
  delete (window as unknown as { webkit?: unknown }).webkit;
  vi.restoreAllMocks();
});

describe('iPhone app schedule sync', () => {
  it('queues a scheduled task for normal record sync instead of the schedule-history service', async () => {
    const task = await createTask({ title: '打合せ', scheduledDate: '2026-10-16', startMinute: 600 });
    expect(await db.scheduleOutbox.count()).toBe(0);
    const queued = await db.outbox.where('[entityType+entityId]').equals(['task', task.id]).first();
    expect((queued?.payload as Task).startMinute).toBe(600);
  });

  it('moves anything already queued for the schedule-history service and never calls it', async () => {
    const task = { id: 't-old', title: '0.4.0で変更', status: 'planned', scheduledDate: '2026-10-16', startMinute: 540, deletedAt: null, sync: { deviceId: 'x' } } as unknown as Task;
    await db.tasks.put(task);
    await db.scheduleOutbox.add({ operationId: 'op1', taskId: 't-old', baseRevision: null, taskPayload: task, updateTask: true, history: {} as never, createdAt: new Date().toISOString(), attempts: 0 });
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('sasshy_v2_push_if')) {
        const body = JSON.parse(String(init?.body));
        return json({ status: 'ok', row: { record_type: 'task', id: body.p_id, payload: body.p_payload, deleted: false, updated_at: '2026-10-15T05:00:00+00:00' } });
      }
      if (url.includes('sasshy_v2_pull')) return json([]);
      throw new Error(`unexpected ${url}`);
    });
    await syncNow(true);
    expect(calls.some((url) => url.includes('sasshy-schedule-history'))).toBe(false);
    expect(await db.scheduleOutbox.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.tasks.get('t-old'))?.sync.serverUpdatedAt).toBe('2026-10-15T05:00:00+00:00');
  });
});
