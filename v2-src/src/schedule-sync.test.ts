import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensureDefaults } from './db';
import { syncScheduleHistory } from './schedule-sync';
import { createTask, updateTask } from './store';
import type { SyncConfig, Task } from './types';

const config: SyncConfig = {
  id: 'sync',
  enabled: true,
  url: 'https://example.supabase.co',
  apiKey: 'sb_publishable_test',
  syncKey: 'schedule-sync-test',
  lastSyncAt: null,
  lastError: '',
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.tasks.clear(),
    db.sessions.clear(),
    db.memos.clear(),
    db.history.clear(),
    db.outbox.clear(),
    db.scheduleHistory.clear(),
    db.scheduleOutbox.clear(),
    db.settings.clear(),
  ]);
  await ensureDefaults();
  vi.restoreAllMocks();
});

describe('dedicated schedule synchronization', () => {
  it('sends offline operations in order and chains server revisions', async () => {
    const task = await createTask({ title: '順序を守る', scheduledDate: '2026-09-08', startMinute: 600 });
    await updateTask(task.id, { scheduledDate: '2026-09-10' }, '日付変更');
    const requests: Array<Record<string, unknown>> = [];
    const revisions = [
      '2026-09-08T00:00:01.000000Z',
      '2026-09-08T00:00:02.000000Z',
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/apply')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const revision = revisions[requests.length - 1];
        return response({
          ok: true,
          revision,
          history: {
            ...(body.history as Record<string, unknown>),
            serverReceivedAt: revision,
          },
        });
      }
      return response({ ok: true, history: [] });
    });

    await expect(syncScheduleHistory(config)).resolves.toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].baseRevision).toBeNull();
    expect(requests[1].baseRevision).toBe(revisions[0]);
    expect(await db.scheduleOutbox.count()).toBe(0);
    expect((await db.tasks.get(task.id))?.sync.serverUpdatedAt).toBe(revisions[1]);
    expect((await db.scheduleHistory.toArray()).every((entry) => entry.serverReceivedAt)).toBe(true);
  });

  it('keeps the local task and marks the queued operation on revision conflict', async () => {
    const task = await createTask({ title: '競合する予定', scheduledDate: '2026-09-08', startMinute: 600 });
    const initialRevision = '2026-09-08T00:00:01.000000Z';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/apply')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          ok: true,
          revision: initialRevision,
          history: { ...(body.history as Record<string, unknown>), serverReceivedAt: initialRevision },
        });
      }
      return response({ ok: true, history: [] });
    });
    await syncScheduleHistory(config);

    const local = await updateTask(task.id, { scheduledDate: '2026-09-10' }, '端末側の変更');
    const remote: Task = {
      ...(local as Task),
      scheduledDate: '2026-09-12',
      updatedAt: '2026-09-08T00:00:03.000Z',
      sync: { ...(local as Task).sync, serverUpdatedAt: '2026-09-08T00:00:03.000000Z' },
    };
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      ok: false,
      conflict: true,
      serverRevision: remote.sync.serverUpdatedAt,
      serverTask: remote,
    }));

    await expect(syncScheduleHistory(config)).rejects.toThrow('別の端末');
    expect((await db.tasks.get(task.id))?.scheduledDate).toBe('2026-09-10');
    const conflict = await db.scheduleOutbox.where('taskId').equals(task.id).first();
    expect(conflict?.conflictRevision).toBe(remote.sync.serverUpdatedAt);
    expect(conflict?.conflictTask?.scheduledDate).toBe('2026-09-12');
  });
});
