import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensureDefaults, getDeviceId } from './db';
import { saveSyncConfig, syncNow } from './sync';
import type { CloudRecord, OutboxItem, Task } from './types';

const S0 = '2026-10-15T00:00:00.000000+00:00';
const S1 = '2026-10-15T01:00:00.000000+00:00';
const S2 = '2026-10-15T02:00:00.000000+00:00';

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function task(id: string, over: Record<string, unknown> = {}): Task {
  return { id, title: id, status: 'planned', deletedAt: null, sync: { deviceId: 'x', serverUpdatedAt: S0 }, ...over } as unknown as Task;
}

async function queue(t: Task): Promise<void> {
  await db.tasks.put(t);
  await db.outbox.add({ entityType: 'task', entityId: t.id, payload: t, deleted: false, createdAt: new Date().toISOString(), attempts: 0 } as OutboxItem);
}

type Handler = (body: Record<string, unknown>) => Response;
function route(handlers: Record<string, Handler>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const name = String(input).split('/rpc/')[1];
    const body = JSON.parse(String(init?.body || '{}'));
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected rpc ${name}`);
    return handler(body);
  });
}

const row = (id: string, updated_at: string, payload: Record<string, unknown>): CloudRecord =>
  ({ record_type: 'task', id, payload, deleted: false, updated_at }) as unknown as CloudRecord;

beforeEach(async () => {
  await db.open();
  await Promise.all([db.tasks.clear(), db.sessions.clear(), db.memos.clear(), db.history.clear(), db.outbox.clear(), db.settings.clear()]);
  await ensureDefaults();
  await saveSyncConfig({ enabled: true, url: 'https://example.supabase.co', apiKey: 'sb_publishable_test', syncKey: 'sync-test' });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('sync reliability', () => {
  it('sends the last seen server time and keeps the cloud version on a real conflict', async () => {
    const mine = task('t1', { status: 'planned', title: '古い内容' });
    await queue(mine);
    const theirs = { ...mine, status: 'done', title: '他端末で完了', sync: { deviceId: 'other-device' } };
    const sent: Record<string, unknown>[] = [];
    route({
      sasshy_v2_push_if: (b) => { sent.push(b); return json({ status: 'conflict', row: row('t1', S1, theirs) }); },
      sasshy_v2_pull: () => json([row('t1', S1, theirs)]),
    });
    await syncNow(true);
    expect(sent[0].p_base_updated_at).toBe(S0);
    expect((await db.tasks.get('t1'))?.status).toBe('done');
    expect(await db.outbox.count()).toBe(0);
    const conflict = (await db.history.toArray()).find((h) => h.action === 'sync-conflict');
    expect((conflict?.before as Task).title).toBe('古い内容');
  });

  it('treats a newer version written by this same device as its own and overwrites it', async () => {
    const me = await getDeviceId();
    await queue(task('t2', { title: '最新' }));
    const bases: unknown[] = [];
    route({
      sasshy_v2_push_if: (b) => {
        bases.push(b.p_base_updated_at);
        return b.p_base_updated_at === S1
          ? json({ status: 'ok', row: row('t2', S2, b.p_payload as Record<string, unknown>) })
          : json({ status: 'conflict', row: row('t2', S1, { id: 't2', title: '直前の自分の送信', sync: { deviceId: me } }) });
      },
      sasshy_v2_pull: () => json([]),
    });
    await syncNow(true);
    expect(bases).toEqual([S0, S1]);
    expect((await db.tasks.get('t2'))?.sync.serverUpdatedAt).toBe(S2);
    expect((await db.history.toArray()).filter((h) => h.action === 'sync-conflict')).toHaveLength(0);
  });

  it('keeps sending the other records when one fails, and records the failure', async () => {
    await queue(task('bad'));
    await queue(task('good'));
    route({
      sasshy_v2_push_if: (b) => b.p_id === 'bad'
        ? json({ message: 'invalid payload' }, 500)
        : json({ status: 'ok', row: row(String(b.p_id), S1, b.p_payload as Record<string, unknown>) }),
      sasshy_v2_pull: () => json([]),
    });
    await syncNow(true);
    const left = await db.outbox.toArray();
    expect(left.map((i) => i.entityId)).toEqual(['bad']);
    expect(left[0].attempts).toBe(1);
    expect(left[0].lastError).toContain('500');
    expect((await db.tasks.get('good'))?.sync.serverUpdatedAt).toBe(S1);
  });

  it('stops on an authentication error and keeps every record queued', async () => {
    await queue(task('a'));
    await queue(task('b'));
    route({ sasshy_v2_push_if: () => json({ message: 'invalid credential', code: '28000' }, 403) });
    await expect(syncNow(true)).rejects.toThrow('403');
    expect(await db.outbox.count()).toBe(2);
  });

  it('falls back to the legacy push when the server has no sasshy_v2_push_if', async () => {
    await queue(task('t3'));
    const legacy = vi.fn((b: Record<string, unknown>) => json([row('t3', S1, b.p_payload as Record<string, unknown>)]));
    route({
      sasshy_v2_push_if: () => json({ code: 'PGRST202', message: 'Could not find the function public.sasshy_v2_push_if' }, 404),
      sasshy_v2_push: legacy,
      sasshy_v2_pull: () => json([]),
    });
    await syncNow(true);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(await db.outbox.count()).toBe(0);
  });
});
