type Json = Record<string, unknown>;

export const WORK_START_ATTEMPT_LIMIT = 2;

export interface WorkStartRecord {
  workspace_hash: string;
  id: string;
  payload: Json;
}

export interface WorkStartCandidate {
  workspaceHash: string;
  key: string;
  familyKey: string;
  endpointHash: string;
  at: number;
  priority: number;
  payload: {
    title: string;
    body: string;
    tag: string;
    kind: string;
    sourceId: string;
    url: string;
  };
}

function shortText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function time(value: unknown): number | null {
  const parsed = Date.parse(shortText(value, 40));
  return Number.isFinite(parsed) ? parsed : null;
}

function dayEntries(payload: Json): Array<[string, Json]> {
  const support = payload.workStartSupport;
  if (!support || typeof support !== 'object' || (support as Json).version !== 1) return [];
  const days = (support as Json).days;
  if (!days || typeof days !== 'object') return [];
  return Object.entries(days as Json).filter((entry): entry is [string, Json] => Boolean(entry[1]) && typeof entry[1] === 'object');
}

export function hasEnabledWorkStartForDate(payload: Json, date: string): boolean {
  return dayEntries(payload).some(([dateKey, day]) => dateKey === date && day.enabled === true);
}

export function hasWorkStartForDate(payload: Json, date: string): boolean {
  return dayEntries(payload).some(([dateKey]) => dateKey === date);
}

export function workStartCandidates(record: WorkStartRecord): WorkStartCandidate[] {
  if (['done', 'archived'].includes(shortText(record.payload.status, 20)) || record.payload.deletedAt) return [];
  const title = shortText(record.payload.title, 180) || 'SASSHYの重要仕事';
  const candidates: WorkStartCandidate[] = [];
  for (const [dateKey, day] of dayEntries(record.payload)) {
    if (
      day.enabled !== true
      || day.skippedAt
      || day.mainStartReportedAt
      || day.mainStartedAt
      || shortText(day.notificationEndpointHash, 64).length !== 64
    ) continue;
    const targetAt = time(day.currentTargetAt);
    const safeAt = time(day.latestSafeStartAt);
    if (targetAt === null || safeAt === null) continue;
    const snoozedAt = time(day.snoozedUntil);
    const anchor = shortText(day.anchorText, 140);
    const familyKey = `work-start:${record.id}:${dateKey}`;
    const common = {
      workspaceHash: record.workspace_hash,
      familyKey,
      endpointHash: shortText(day.notificationEndpointHash, 64),
    };
    const make = (kind: 'current' | 'snooze' | 'safe', at: number): WorkStartCandidate => ({
      ...common,
      key: `${familyKey}:${kind}:${at}`,
      at,
      priority: kind === 'safe' ? 3 : kind === 'snooze' ? 2 : 1,
      payload: {
        title: kind === 'safe' ? '今は本作業を始める時間です' : '本作業を始める目標時刻です',
        body: anchor ? `${title}：まず「${anchor}」から始めます` : title,
        tag: `sasshy-work-start-${record.id}-${dateKey}`,
        kind: `work-start-${kind}`,
        sourceId: record.id,
        url: './?open=today',
      },
    });
    if (snoozedAt !== null && snoozedAt < safeAt) candidates.push(make('snooze', snoozedAt));
    else candidates.push(make('current', targetAt));
    candidates.push(make('safe', safeAt));
  }
  return candidates;
}

export function dueWorkStartCandidates(
  candidates: WorkStartCandidate[],
  now: number,
  attemptsByFamily: ReadonlyMap<string, number>,
): WorkStartCandidate[] {
  const due = candidates
    .filter((item) => item.at <= now && item.at >= now - 10 * 60_000)
    .sort((a, b) => b.priority - a.priority || b.at - a.at);
  const selected = new Map<string, WorkStartCandidate>();
  for (const item of due) {
    if ((attemptsByFamily.get(item.familyKey) || 0) >= WORK_START_ATTEMPT_LIMIT) continue;
    if (!selected.has(item.familyKey)) selected.set(item.familyKey, item);
  }
  return [...selected.values()];
}
