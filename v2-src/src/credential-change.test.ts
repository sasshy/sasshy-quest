import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { db, ensureDefaults } from './db';
import { getSyncConfig, saveSyncConfig } from './sync';
import { createBackup } from './backup';

const old = 'synthetic-old-credential';
const fresh = 'synthetic-new-credential';
const workspace = 'a'.repeat(64);
const response = (id = workspace) => ({ ok: true, status: 200, json: async () => ({ workspaceId: id }) }) as Response;
let snapshot: string;
beforeEach(async () => {
  await db.open();
  for (const table of db.tables) await table.clear();
  await ensureDefaults();
  await saveSyncConfig({ enabled: false, url: 'https://example.supabase.co', apiKey: 'sb_publishable_synthetic', syncKey: old });
  const payload = { id: 'pending-a', title: 'Unsent edit', unknown: { keep: true } };
  await db.tasks.put(payload as never);
  await db.outbox.add({ id: 72, entityType: 'task', entityId: payload.id, payload, deleted: false, createdAt: '2026-09-12', attempts: 3 } as never);
  snapshot = JSON.stringify(await db.outbox.toArray());
});
afterEach(() => vi.restoreAllMocks());

it('verifies the same permanent workspace and retains pending operations on rotation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  await saveSyncConfig({ syncKey: fresh });
  const current = await getSyncConfig();
  expect(current.syncKey).toBe(fresh);
  expect(current.workspaceId).toBe(workspace);
  expect(current.enabled).toBe(false);
  expect(JSON.stringify(await db.outbox.toArray())).toBe(snapshot);
  expect(fetch.mock.calls.map(c => JSON.parse(String(c[1]?.body)).p_sync_key)).toEqual([old, fresh]);
  expect((await createBackup(db)).counts.outbox).toBe(1);
});

it('rejects a different workspace before writing settings or sending pending edits', async () => {
  const before = await getSyncConfig();
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(response('b'.repeat(64)));
  await expect(saveSyncConfig({ syncKey: fresh })).rejects.toThrow('別の保存先');
  expect(await getSyncConfig()).toEqual(before);
  expect(JSON.stringify(await db.outbox.toArray())).toBe(snapshot);
});

it.each([401, 503])('keeps source and backup available when preflight fails with %s', async status => {
  const before = await getSyncConfig();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status, json: async () => ({ error: 'invalid credential' }) } as Response);
  await expect(saveSyncConfig({ syncKey: fresh })).rejects.toThrow('設定は保持');
  expect(await getSyncConfig()).toEqual(before);
  expect(JSON.stringify(await db.outbox.toArray())).toBe(snapshot);
  expect((await createBackup(db)).counts.tasks).toBe(1);
});

it('rejects setting races while preserving the newer settings', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await db.settings.update('sync', { syncKey: 'synthetic-other-change' });
    return response();
  });
  await expect(saveSyncConfig({ syncKey: fresh })).rejects.toThrow('別の操作');
  expect((await getSyncConfig()).syncKey).toBe('synthetic-other-change');
  expect(JSON.stringify(await db.outbox.toArray())).toBe(snapshot);
});

it('allows disabling sync offline without trusting a supplied workspace identity', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await saveSyncConfig({ enabled: false, workspaceId: 'b'.repeat(64) });
  expect((await getSyncConfig()).workspaceId).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('continues persisting ordinary sync success and error metadata', async () => {
  const at = '2026-09-12T00:00:00Z';
  await saveSyncConfig({ lastSyncAt: at, lastError: 'offline' });
  expect((await getSyncConfig()).lastSyncAt).toBe(at);
  expect((await getSyncConfig()).lastError).toBe('offline');
  await saveSyncConfig({ lastError: '' });
  expect((await getSyncConfig()).lastError).toBe('');
});
