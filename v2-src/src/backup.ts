import Dexie from 'dexie';
import { SasshyDatabase, makeId } from './db';
import { version as appVersion } from '../package.json';

export const BACKUP_TABLES = [
  'tasks', 'memos', 'sessions', 'history', 'outbox',
  'scheduleHistory', 'scheduleOutbox', 'settings',
] as const;
type TableName = typeof BACKUP_TABLES[number];
type Row = Record<string, unknown>;
export type BackupTables = Record<TableName, Row[]>;
export interface MissingReference {
  table: TableName;
  rowId: string | number;
  field: string;
  targetTable: TableName;
  targetId: string;
}
export interface Backup {
  format: 'sasshy-web-backup';
  formatVersion: 1;
  schemaVersion: 2;
  appVersion: string;
  exportedAt: string;
  tables: BackupTables;
  counts: Record<TableName, number>;
  pending: { records: number; schedules: number; conflicts: number };
  references: { missing: MissingReference[] };
  exclusions: { settingsPolicy: 1; omittedSettingRows: number; reconfigure: string[] };
  checksum: { algorithm: 'SHA-256'; value: string };
}

function invalid(): never {
  throw new Error('バックアップの形式または参照情報が不正です。データは変更していません。');
}
function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function row(value: unknown): Row {
  if (!isRow(value)) invalid();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}

/** Deterministic JSON; reject unsupported values instead of silently losing them.
 * Optional undefined object properties have JSON's usual absent-field meaning.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item)) invalid();
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      // Sparse arrays and undefined array entries cannot be round-tripped as JSON.
      result = `[${Array.from(item, encode).join(',')}]`;
    } else {
      const record = row(item);
      result = `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return encode(value);
}

async function digest(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('バックアップの整合性を確認できません。HTTPSまたはlocalhostで開いてください。');
  }
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type FieldType = 'string' | 'number' | 'boolean' | 'nullable-string';
function fields(source: Row, spec: Record<string, FieldType>): Row {
  return Object.fromEntries(Object.entries(spec).flatMap(([key, type]) => {
    const value = source[key];
    if (value === undefined) return [];
    if (type === 'nullable-string' ? value !== null && typeof value !== 'string'
      : typeof value !== type || (type === 'number' && !Number.isFinite(value))) invalid();
    return [[key, value]];
  }));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function undoAction(value: unknown): Row {
  const action = row(value);
  const projected = fields(action, {
    id: 'string', label: 'string', expectedUpdatedAt: 'nullable-string', createdAt: 'string',
  });
  // Task snapshots are data, not connection settings: retain additional task fields.
  for (const key of ['before', 'after']) {
    if (action[key] !== undefined) projected[key] = action[key] === null ? null : row(action[key]);
  }
  for (const key of ['beforeGroup', 'afterGroup']) {
    if (action[key] !== undefined) projected[key] = array(action[key]).map(row);
  }
  if (action.scheduleOperationIds !== undefined) projected.scheduleOperationIds = array(action.scheduleOperationIds).map(string);
  if (action.expectedUpdatedAts !== undefined) {
    projected.expectedUpdatedAts = Object.fromEntries(Object.entries(row(action.expectedUpdatedAts))
      .map(([key, value]) => [key, string(value)]));
  }
  return projected;
}

/** Allowlist at every settings envelope. Never copy arbitrary setting objects. */
function safeSettings(settings: Row[]): Row[] {
  return settings.flatMap((setting) => {
    const id = string(setting.id);
    switch (id) {
      case 'voice': {
        const safe = fields(setting, {
          enabled: 'boolean', rate: 'number', volume: 'number', everyMinute: 'boolean', finalCountdown: 'boolean',
        });
        if (setting.announcements !== undefined) {
          safe.announcements = array(setting.announcements).map((value) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
            return value;
          });
        }
        return [{ id, ...safe }];
      }
      case 'device': return [{ id, ...fields(setting, { value: 'string' }) }];
      case 'undo-redo': return [{ id, undo: array(setting.undo).map(undoAction), redo: array(setting.redo).map(undoAction) }];
      case 'push': return [{ id, ...fields(setting, { deviceName: 'string' }) }];
      case 'google-calendar': return [{
        id, ...fields(setting, { lastSyncAt: 'nullable-string' }),
        events: array(setting.events).map((event) => fields(row(event), {
          id: 'string', title: 'string', start: 'string', end: 'nullable-string', allDay: 'boolean', calendarName: 'string', color: 'string',
        })),
      }];
      default:
        if (/^task-link:[A-Za-z0-9._:-]{1,200}$/.test(id)) {
          return [{ id, ...fields(setting, { taskId: 'string', importedAt: 'string' }) }];
        }
        // Includes sync, tokens, subscription keys, connection errors and unknown settings.
        return [];
    }
  });
}

function validateTables(value: unknown): BackupTables {
  const data = row(value);
  if (Object.keys(data).sort().join() !== [...BACKUP_TABLES].sort().join()) invalid();
  for (const name of BACKUP_TABLES) {
    const seen = new Set<unknown>();
    for (const value of array(data[name])) {
      const record = row(value);
      const id = record.id;
      if (name === 'outbox' || name === 'scheduleOutbox') {
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) invalid();
      } else if (typeof id !== 'string' || !id) invalid();
      if (seen.has(id)) invalid();
      seen.add(id);
    }
  }
  const tables = data as BackupTables;
  if (canonicalJson(tables.settings) !== canonicalJson(safeSettings(tables.settings))) invalid();
  for (const queued of tables.outbox) {
    if (!['task', 'memo', 'session'].includes(string(queued.entityType))) invalid();
    if (typeof queued.entityId !== 'string' || !queued.entityId || row(queued.payload).id !== queued.entityId) invalid();
  }
  for (const queued of tables.scheduleOutbox) {
    const history = row(queued.history);
    if (typeof queued.taskId !== 'string' || !queued.taskId || typeof queued.operationId !== 'string' || !queued.operationId
      || queued.taskId !== row(queued.taskPayload).id || history.taskId !== queued.taskId
      || history.id !== queued.operationId || typeof queued.updateTask !== 'boolean') invalid();
    if (queued.conflictTask != null && row(queued.conflictTask).id !== queued.taskId) invalid();
  }
  return tables;
}

function summary(tables: BackupTables) {
  const counts = Object.fromEntries(BACKUP_TABLES.map((name) => [name, tables[name].length])) as Backup['counts'];
  const missing: MissingReference[] = [];
  const ids = Object.fromEntries(BACKUP_TABLES.map((name) => [name, new Set(tables[name].map((r) => r.id))])) as Record<TableName, Set<unknown>>;
  function ref(table: TableName, record: Row, field: string, targetTable: TableName, value = record[field]) {
    if (value === undefined || value === null || value === '') return;
    const targetId = string(value);
    if (!ids[targetTable].has(targetId)) missing.push({ table, rowId: record.id as string | number, field, targetTable, targetId });
  }
  for (const r of tables.sessions) ref('sessions', r, 'taskId', 'tasks');
  for (const r of tables.history) {
    if (r.entityType === 'task') ref('history', r, 'entityId', 'tasks');
    if (r.entityType === 'session') ref('history', r, 'entityId', 'sessions');
  }
  for (const r of tables.outbox) ref('outbox', r, 'entityId', { task: 'tasks', memo: 'memos', session: 'sessions' }[string(r.entityType)] as TableName);
  for (const r of tables.scheduleHistory) {
    ref('scheduleHistory', r, 'taskId', 'tasks');
    ref('scheduleHistory', r, 'relatedEntryId', 'scheduleHistory');
  }
  for (const r of tables.scheduleOutbox) {
    ref('scheduleOutbox', r, 'taskId', 'tasks');
    ref('scheduleOutbox', r, 'operationId', 'scheduleHistory');
  }
  for (const r of tables.settings) {
    if (string(r.id).startsWith('task-link:')) ref('settings', r, 'taskId', 'tasks');
  }
  return {
    counts,
    pending: { records: counts.outbox, schedules: counts.scheduleOutbox, conflicts: tables.scheduleOutbox.filter((r) => r.conflictRevision != null || r.conflictTask != null).length },
    references: { missing },
  };
}

export async function createBackup(database: SasshyDatabase): Promise<Backup> {
  await database.open();
  if (database.verno !== 2 || database.tables.map((t) => t.name).sort().join() !== [...BACKUP_TABLES].sort().join()) {
    throw new Error('この保存形式には未対応です。データは変更していません。');
  }
  // Only IndexedDB promises inside this single readonly transaction. Hash outside it.
  const snapshot = await database.transaction('r', BACKUP_TABLES.map((name) => database.table(name)), async () => {
    const exportedAt = new Date().toISOString();
    const rows = await Promise.all(BACKUP_TABLES.map((name) => database.table(name).toArray()));
    return { exportedAt, tables: Object.fromEntries(BACKUP_TABLES.map((name, i) => [name, rows[i]])) as BackupTables };
  });
  const settings = safeSettings(snapshot.tables.settings);
  const omittedSettingRows = snapshot.tables.settings.length - settings.length;
  // Normalize JSON before hashing, validating, or handing it to a caller.
  const tables = validateTables(JSON.parse(canonicalJson({ ...snapshot.tables, settings })));
  const body: Omit<Backup, 'checksum'> = {
    format: 'sasshy-web-backup', formatVersion: 1, schemaVersion: 2, appVersion,
    exportedAt: snapshot.exportedAt, tables, ...summary(tables),
    exclusions: { settingsPolicy: 1, omittedSettingRows, reconfigure: ['sync', 'push', 'google-calendar'] },
  };
  return { ...body, checksum: { algorithm: 'SHA-256', value: await digest(body) } };
}

export async function readBackup(input: string): Promise<Backup> {
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { invalid(); }
  const value = row(parsed);
  if (value.format !== 'sasshy-web-backup' || value.formatVersion !== 1 || value.schemaVersion !== 2) {
    throw new Error('このバックアップ形式には未対応です。元のファイルを保管してください。');
  }
  const expectedKeys = ['format', 'formatVersion', 'schemaVersion', 'appVersion', 'exportedAt', 'tables', 'counts', 'pending', 'references', 'exclusions', 'checksum'];
  if (Object.keys(value).sort().join() !== expectedKeys.sort().join()) invalid();
  if (!string(value.appVersion) || !Number.isFinite(Date.parse(string(value.exportedAt)))) invalid();
  const checksum = row(value.checksum);
  if (checksum.algorithm !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(string(checksum.value))) invalid();
  const { checksum: _checksum, ...body } = value;
  if (await digest(body) !== checksum.value) throw new Error('バックアップの整合性確認に失敗しました。元のファイルを保管してください。');
  const tables = validateTables(value.tables);
  const actual = summary(tables);
  for (const key of ['counts', 'pending', 'references'] as const) {
    if (canonicalJson(actual[key]) !== canonicalJson(value[key])) invalid();
  }
  const exclusions = row(value.exclusions);
  if (exclusions.settingsPolicy !== 1 || !Number.isSafeInteger(exclusions.omittedSettingRows)
    || (exclusions.omittedSettingRows as number) < 0
    || canonicalJson(exclusions.reconfigure) !== canonicalJson(['sync', 'push', 'google-calendar'])) invalid();
  return value as unknown as Backup;
}

/** Verification only: creates a new private DB; no API accepts an existing target.
 * No singleton store, sync scheduler, defaults migration, or network call is used.
 * Caller closes/deletes the returned verification DB after inspecting it.
 */
export async function restoreBackupForVerification(input: string): Promise<SasshyDatabase> {
  const backup = await readBackup(input);
  const name = `sasshy-v2-backup-check-${makeId('restore')}`;
  if (await Dexie.exists(name)) throw new Error('検証用DBが既に存在します。復元を中止しました。');
  const isolated = new SasshyDatabase(name);
  let createdHere = false;
  isolated.on('populate', () => { createdHere = true; });
  try {
    await isolated.open();
    if (!createdHere) throw new Error('検証用DBを新規作成できませんでした。');
    await isolated.transaction('rw', BACKUP_TABLES.map((table) => isolated.table(table)), async () => {
      for (const table of BACKUP_TABLES) {
        if (await isolated.table(table).count()) throw new Error('検証用DBが空ではありません。');
      }
      for (const table of BACKUP_TABLES) await isolated.table(table).bulkAdd(backup.tables[table]);
      await isolated.settings.put({ id: 'sync', enabled: false, url: '', apiKey: '', syncKey: '', lastSyncAt: null, lastError: '' });
      if (await isolated.settings.get('push')) await isolated.settings.update('push', {
        enabled: false, endpoint: '', lastRegisteredAt: null, lastTestAt: null, lastError: '',
      });
      if (await isolated.settings.get('google-calendar')) await isolated.settings.update('google-calendar', {
        enabled: false, feedUrl: '', lastError: '',
      });
    });
    const restored = await createBackup(isolated);
    if (canonicalJson(restored.tables) !== canonicalJson(backup.tables)
      || canonicalJson(restored.pending) !== canonicalJson(backup.pending)) {
      throw new Error('検証用DBの復元結果が一致しませんでした。');
    }
    return isolated;
  } catch (error) {
    isolated.close();
    if (createdHere) await isolated.delete();
    throw error;
  }
}

export function downloadBackup(backup: Backup): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `sasshy-web-backup-${backup.exportedAt.replace(/[:.]/g, '-')}.json`;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Safari needs the object URL to survive the initiating event.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
