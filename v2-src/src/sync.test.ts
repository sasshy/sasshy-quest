import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensureDefaults } from './db';
import { saveSyncConfig, syncNow } from './sync';

const emptyResponse = () => ({
  ok: true,
  status: 200,
  json: async () => [],
  text: async () => '',
}) as Response;

beforeEach(async () => {
  await db.open();
  await Promise.all([db.tasks.clear(), db.sessions.clear(), db.memos.clear(), db.history.clear(), db.outbox.clear(), db.settings.clear()]);
  await ensureDefaults();
  await saveSyncConfig({
    enabled: true,
    url: 'https://example.supabase.co',
    apiKey: 'sb_publishable_test',
    syncKey: 'sync-test',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync resume coordination', () => {
  it('runs a queued sync after the current request finishes', async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        releaseFirst = resolve;
        markStarted?.();
      }))
      .mockResolvedValue(emptyResponse());

    const first = syncNow();
    await started;
    syncNow();
    releaseFirst?.(emptyResponse());
    await first;
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
