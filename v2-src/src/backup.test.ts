// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { version as appVersion } from '../package.json';
import { SasshyDatabase } from './db';
import { BACKUP_TABLES, canonicalJson, createBackup, readBackup, restoreBackupForVerification, type Backup, type BackupTables } from './backup';

const webcrypto = globalThis.crypto;
const at = '2026-09-01T12:00:00.000Z';
const task = (id: string, extra = {}) => ({
  id, title: 'Synthetic task', notes: 'Synthetic notes', status: 'planned', horizon: 'now',
  scheduledDate: '2026-09-01', startMinute: 600, scheduleVersionId: 'version-current',
  durationMin: 25, estimateMin: 25, importance: 1, urgency: 0, createdAt: at, updatedAt: at,
  completedAt: null, deletedAt: null, source: 'v2', sync: { deviceId: 'synthetic-device', serverUpdatedAt: at },
  siriExtra: { source: 'voice', originalRequestId: 'synthetic-request', future: [1, null, { retained: true }] },
  ...extra,
});
const history = (id: string, result = 'unconfirmed') => ({
  id, taskId: 'task-a', operationGroupId: 'synthetic-group', beforeVersionId: null,
  afterVersionId: 'version-current', targetVersionId: 'version-past', operation: result === 'unconfirmed' ? 'schedule' : 'set_result',
  result, before: null, after: { scheduleVersionId: 'version-current', scheduledDate: '2026-09-01', startMinute: 600, durationMin: 25, title: 'Synthetic' },
  title: 'Synthetic', occurredAt: at, serverReceivedAt: null, deviceId: 'synthetic-device', source: 'local', relatedEntryId: null, reason: '',
});
function fixture(): BackupTables {
  const a = task('task-a');
  const removed = task('task-trash', { status: 'archived', deletedAt: at, extraUnknown: { keep: true } });
  const session = { id: 'session-a', taskId: 'task-a', taskTitle: 'Synthetic task', plannedMin: 25, carriedElapsedSec: 23,
    startedAt: at, pausedAt: at, pausedTotalSec: 12, endedAt: null, status: 'paused', createdAt: at, updatedAt: at, deletedAt: null, sync: a.sync };
  const memo = { id: 'memo-a', title: 'Synthetic memo', body: 'Synthetic body', category: 'test', pinned: true, reminderAt: null,
    archived: false, createdAt: at, updatedAt: at, deletedAt: null, source: 'v2', sync: a.sync };
  const h1 = history('schedule-a'), h2 = history('result-a', 'not_done');
  return {
    tasks: [a, removed], sessions: [session], memos: [memo],
    history: [{ id: 'history-a', entityType: 'task', entityId: 'task-trash', action: 'delete', label: 'Synthetic', before: a,
      after: removed, createdAt: at, source: 'local', unknownAuditField: { keep: true } }],
    outbox: [
      { id: 7, entityType: 'task', entityId: 'task-a', payload: { ...a, title: 'Unsent ordinary edit' }, deleted: false, createdAt: at, attempts: 2 },
      { id: 42, entityType: 'session', entityId: 'session-a', payload: session, deleted: false, createdAt: at, attempts: 1 },
      { id: 70, entityType: 'memo', entityId: 'memo-a', payload: memo, deleted: false, createdAt: at, attempts: 0 },
    ],
    scheduleHistory: [h1, h2],
    scheduleOutbox: [
      { id: 8, operationId: h1.id, taskId: a.id, baseRevision: at, taskPayload: a, updateTask: true, history: h1, createdAt: at, attempts: 1 },
      { id: 15, operationId: h2.id, taskId: a.id, baseRevision: at, taskPayload: a, updateTask: false, history: h2, createdAt: at,
        attempts: 3, conflictRevision: '2026-09-01T13:00:00.000Z', conflictTask: { ...a, title: 'Synthetic server conflict' }, futurePendingField: [1, 2] },
    ],
    settings: [
      { id: 'device', value: 'synthetic-device', apiKey: 'SYNTHETIC-DEVICE-SECRET' },
      { id: 'voice', enabled: true, rate: 1.1, volume: 0.7, everyMinute: true, finalCountdown: false, announcements: [15, 3, 1], token: 'SYNTHETIC-VOICE-TOKEN' },
      { id: 'sync', enabled: true, url: 'https://example.invalid/?key=SYNTHETIC-URL-SECRET', apiKey: 'SYNTHETIC-API-KEY', syncKey: 'SYNTHETIC-SYNC-KEY', access_token: 'SYNTHETIC-TOKEN' },
      { id: 'push', enabled: true, deviceName: 'Synthetic phone', endpoint: 'https://example.invalid/SYNTHETIC-PUSH-ENDPOINT', subscription: { keys: { auth: 'SYNTHETIC-AUTH', p256dh: 'SYNTHETIC-P256' } }, lastError: 'SYNTHETIC-ERROR-SECRET' },
      { id: 'google-calendar', enabled: true, feedUrl: 'https://example.invalid/SYNTHETIC-CALENDAR-KEY', lastSyncAt: at,
        events: [{ id: 'event-a', title: 'Synthetic event', start: '2026-09-01', end: null, allDay: true, calendarName: 'Synthetic calendar', color: '#abc', token: 'SYNTHETIC-EVENT-TOKEN' }] },
      { id: 'undo-redo', token: 'SYNTHETIC-UNDO-TOKEN', undo: [{ id: 'undo-a', label: 'Synthetic', before: null, after: a,
        expectedUpdatedAt: at, createdAt: at, scheduleOperationIds: ['schedule-a'], apiKey: 'SYNTHETIC-ACTION-KEY' }], redo: [] },
      { id: 'task-link:synthetic-receipt', taskId: a.id, importedAt: at, token: 'SYNTHETIC-RECEIPT-TOKEN' },
      { id: 'native-keychain', value: { secret: 'SYNTHETIC-KEYCHAIN' } },
      { id: 'future-connection', nested: { token: 'SYNTHETIC-FUTURE-TOKEN' } },
    ],
  };
}
let source: SasshyDatabase;
const restoredDatabases: SasshyDatabase[] = [];
async function raw(database = source) {
  return Object.fromEntries(await Promise.all(BACKUP_TABLES.map(async (name) => [name, await database.table(name).toArray()])));
}
async function restore(input: Backup) {
  const result = await restoreBackupForVerification(JSON.stringify(input));
  restoredDatabases.push(result);
  return result;
}
async function resign(backup: Backup): Promise<string> {
  const { checksum: _, ...body } = backup;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(body)));
  backup.checksum.value = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return JSON.stringify(backup);
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  source = new SasshyDatabase(`p2-synthetic-${webcrypto.randomUUID()}`);
  await source.open();
  const data = fixture();
  for (const name of BACKUP_TABLES) await source.table(name).bulkAdd(data[name]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of [source, ...restoredDatabases.splice(0)]) await database.delete();
  vi.unstubAllGlobals();
});

describe('P2 complete local backup', () => {
  it('round-trips all seven data tables, safe settings, IDs and pending operations', async () => {
    const before = await raw();
    const backup = await createBackup(source);
    expect(backup).toMatchObject({ formatVersion: 1, schemaVersion: 2, appVersion,
      pending: { records: 3, schedules: 2, conflicts: 1 }, references: { missing: [] } });
    expect(backup.counts).toEqual({ tasks: 2, sessions: 1, memos: 1, history: 1, outbox: 3, scheduleHistory: 2, scheduleOutbox: 2, settings: 6 });
    const copy = await restore(backup);
    for (const name of BACKUP_TABLES.filter((name) => name !== 'settings')) {
      expect(await copy.table(name).toArray()).toEqual(before[name]);
    }
    expect((await copy.scheduleOutbox.get(15))?.updateTask).toBe(false);
    expect((await copy.scheduleOutbox.get(15))?.conflictRevision).toBe('2026-09-01T13:00:00.000Z');
    expect(await copy.settings.get('voice')).toEqual({ id: 'voice', enabled: true, rate: 1.1, volume: 0.7, everyMinute: true, finalCountdown: false, announcements: [15, 3, 1] });
    expect((await copy.settings.get('undo-redo'))?.undo).toEqual(backup.tables.settings.find((r) => r.id === 'undo-redo')?.undo);
    expect(await raw()).toEqual(before);
    const { checksum, ...body } = backup;
    expect(checksum.value).toMatch(/^[a-f0-9]{64}$/);
    expect(await readBackup(JSON.stringify({ ...body, checksum }))).toEqual(backup);
  });

  it('never exports credentials in settings envelopes or nested event/action metadata', async () => {
    const backup = await createBackup(source);
    const text = JSON.stringify(backup);
    for (const secret of ['SYNTHETIC-DEVICE-SECRET','SYNTHETIC-VOICE-TOKEN','SYNTHETIC-API-KEY','SYNTHETIC-SYNC-KEY',
      'SYNTHETIC-TOKEN','SYNTHETIC-URL-SECRET','SYNTHETIC-PUSH-ENDPOINT','SYNTHETIC-AUTH','SYNTHETIC-P256',
      'SYNTHETIC-ERROR-SECRET','SYNTHETIC-CALENDAR-KEY','SYNTHETIC-EVENT-TOKEN','SYNTHETIC-UNDO-TOKEN',
      'SYNTHETIC-ACTION-KEY','SYNTHETIC-RECEIPT-TOKEN','SYNTHETIC-KEYCHAIN','SYNTHETIC-FUTURE-TOKEN']) expect(text).not.toContain(secret);
    expect(backup.exclusions).toEqual({ settingsPolicy: 1, omittedSettingRows: 3, reconfigure: ['sync','push','google-calendar'] });
    expect(text).not.toMatch(/"(?:apiKey|syncKey|access_token|feedUrl|endpoint|subscription|token)"/);
  });

  it('restores with network integrations disabled without changing source settings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const before = await source.settings.toArray();
    const copy = await restore(await createBackup(source));
    expect(copy.name).toMatch(/^sasshy-v2-backup-check-/);
    expect(copy.name).not.toBe('sasshy-v2');
    expect(await copy.settings.get('sync')).toMatchObject({ enabled: false, url: '', apiKey: '', syncKey: '' });
    expect(await copy.settings.get('push')).toMatchObject({ enabled: false, endpoint: '', deviceName: 'Synthetic phone' });
    expect(await copy.settings.get('google-calendar')).toMatchObject({ enabled: false, feedUrl: '', events: [{ id: 'event-a' }] });
    expect(await source.settings.toArray()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves auto-increment queue IDs and advances new IDs after restore/reopen', async () => {
    const copy = await restore(await createBackup(source));
    copy.close(); await copy.open();
    const ordinary = await copy.outbox.get(7); const scheduled = await copy.scheduleOutbox.get(15);
    const nextRecord = await copy.outbox.add({ ...ordinary!, id: undefined });
    const nextSchedule = await copy.scheduleOutbox.add({ ...scheduled!, id: undefined, operationId: 'synthetic-next' });
    expect(nextRecord).toBeGreaterThan(70);
    expect(nextSchedule).toBeGreaterThan(15);
    expect(await copy.outbox.get(7)).toEqual(ordinary);
  });

  it('uses a single readonly snapshot while a second connection queues a write', async () => {
    const sibling = new SasshyDatabase(source.name); await sibling.open();
    let write: Promise<unknown> | undefined;
    const original = source.table('tasks').toArray.bind(source.table('tasks'));
    vi.spyOn(source.table('tasks'), 'toArray').mockImplementationOnce(() => Dexie.Promise.resolve(undefined).then(async () => {
      expect(Dexie.currentTransaction?.mode).toBe('readonly');
      expect([...Dexie.currentTransaction!.storeNames].sort()).toEqual([...BACKUP_TABLES].sort());
      const result = await original();
      write = Dexie.ignoreTransaction(() => sibling.transaction('rw', sibling.tasks, sibling.outbox, async () => {
        await sibling.tasks.update('task-a', { title: 'Concurrent new title' });
        await sibling.outbox.update(7, { payload: task('task-a', { title: 'Concurrent new title' }) as never });
      }));
      return result;
    }));
    try {
      const backup = await createBackup(source);
      await write;
      expect(backup.tables.tasks.find((t) => t.id === 'task-a')?.title).toBe('Synthetic task');
      expect(backup.tables.outbox.find((t) => t.id === 7)?.payload).toMatchObject({ title: 'Unsent ordinary edit' });
      expect((await sibling.tasks.get('task-a'))?.title).toBe('Concurrent new title');
    } finally { sibling.close(); }
  });

  it('preserves orphan references and reports them rather than discarding records', async () => {
    await source.sessions.update('session-a', { taskId: 'synthetic-missing-task' });
    const backup = await createBackup(source);
    expect(backup.references.missing).toEqual([{ table: 'sessions', rowId: 'session-a', field: 'taskId', targetTable: 'tasks', targetId: 'synthetic-missing-task' }]);
    const copy = await restore(backup);
    expect((await copy.sessions.get('session-a'))?.taskId).toBe('synthetic-missing-task');
  });

  it('leaves every source table unchanged when a read fails', async () => {
    const before = await raw();
    vi.spyOn(source.table('scheduleOutbox'), 'toArray').mockRejectedValueOnce(new Error('Synthetic read failure'));
    await expect(createBackup(source)).rejects.toThrow('Synthetic read failure');
    expect(await raw()).toEqual(before);
  });

  it('leaves every source table unchanged when hashing fails after the snapshot', async () => {
    const before = await raw();
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('Synthetic hashing failure'));
    await expect(createBackup(source)).rejects.toThrow('Synthetic hashing failure');
    expect(await raw()).toEqual(before);
  });

  it('rejects unsupported structured values rather than silently losing unknown fields', async () => {
    await source.table('tasks').update('task-a', { futureDate: new Date(at) });
    const before = await raw();
    await expect(createBackup(source)).rejects.toThrow('形式');
    expect(await raw()).toEqual(before);
  });

  it('rejects malformed JSON, old formats, and changed contents before creating a target', async () => {
    const names = await Dexie.getDatabaseNames();
    await expect(restoreBackupForVerification('{')).rejects.toThrow();
    await expect(restoreBackupForVerification('{"version":2}')).rejects.toThrow('未対応');
    const backup = await createBackup(source); backup.tables.tasks[0].title = 'Tampered';
    await expect(restoreBackupForVerification(JSON.stringify(backup))).rejects.toThrow('整合性');
    expect(await Dexie.getDatabaseNames()).toEqual(names);
  });

  it.each(['count', 'reference', 'identity', 'secret', 'duplicate', 'schema'] as const)('rejects a correctly hashed but invalid %s', async (kind) => {
    const backup = await createBackup(source);
    if (kind === 'count') backup.counts.tasks++;
    if (kind === 'reference') backup.references.missing.push({ table: 'sessions', rowId: 'session-a', field: 'taskId', targetTable: 'tasks', targetId: 'fake' });
    if (kind === 'identity') backup.tables.scheduleOutbox[1].operationId = 'wrong-id';
    if (kind === 'secret') backup.tables.settings.push({ id: 'sync', syncKey: 'SYNTHETIC-INJECTED' });
    if (kind === 'duplicate') backup.tables.tasks.push(backup.tables.tasks[0]);
    if (kind === 'schema') (backup as unknown as { schemaVersion: number }).schemaVersion = 999;
    await expect(restoreBackupForVerification(await resign(backup))).rejects.toThrow();
  });

  it('rolls back an interrupted restore, cleans only its newly created DB, and keeps source intact', async () => {
    const backup = await createBackup(source); const before = await raw();
    let targetName = '';
    const original = SasshyDatabase.prototype.open;
    vi.spyOn(SasshyDatabase.prototype, 'open').mockImplementation(function (this: SasshyDatabase) {
      if (this.name.startsWith('sasshy-v2-backup-check-')) {
        targetName = this.name;
        this.scheduleOutbox.hook('creating', () => { throw new Error('Synthetic write failure'); });
      }
      return original.call(this);
    });
    await expect(restoreBackupForVerification(JSON.stringify(backup))).rejects.toThrow('Synthetic write failure');
    expect(targetName).not.toBe('');
    expect(await Dexie.exists(targetName)).toBe(false);
    expect(await raw()).toEqual(before);
  });

  it('rejects a colliding verification database without touching it', async () => {
    const backup = await createBackup(source); const before = await raw();
    vi.spyOn(Dexie, 'exists').mockResolvedValueOnce(true);
    await expect(restoreBackupForVerification(JSON.stringify(backup))).rejects.toThrow('既に存在');
    expect(await raw()).toEqual(before);
  });

  it('exports and restores an empty database without losing the format reader', async () => {
    for (const name of BACKUP_TABLES) await source.table(name).clear();
    const backup = await createBackup(source);
    expect(backup.pending).toEqual({ records: 0, schedules: 0, conflicts: 0 });
    const copy = await restore(backup);
    expect((await readBackup(JSON.stringify(backup))).checksum).toEqual(backup.checksum);
    expect(await copy.tasks.count()).toBe(0);
  });
});
