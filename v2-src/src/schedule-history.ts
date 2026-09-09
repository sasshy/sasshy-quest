import type {
  ScheduleHistoryEntry,
  ScheduleOperation,
  ScheduleResult,
  ScheduleSnapshot,
  Task,
} from './types';

export function scheduleSnapshot(task: Task): ScheduleSnapshot {
  return {
    scheduleVersionId: task.scheduleVersionId || null,
    scheduledDate: task.scheduledDate,
    startMinute: task.startMinute,
    durationMin: task.durationMin,
    title: task.title,
  };
}

export function scheduleFieldsChanged(before: Task, after: Task): boolean {
  return before.scheduledDate !== after.scheduledDate
    || before.startMinute !== after.startMinute
    || before.durationMin !== after.durationMin;
}

export function classifyScheduleOperation(before: Task, after: Task): ScheduleOperation | null {
  if (!scheduleFieldsChanged(before, after)) return null;
  if (!before.scheduledDate && after.scheduledDate) return 'schedule';
  if (before.scheduledDate && !after.scheduledDate) return 'unschedule';
  const dateChanged = before.scheduledDate !== after.scheduledDate;
  const timeChanged = before.startMinute !== after.startMinute;
  const durationChanged = before.durationMin !== after.durationMin;
  if (dateChanged && (timeChanged || durationChanged)) return 'reschedule';
  if (dateChanged) return 'adjust_date';
  if (timeChanged) return 'adjust_time';
  return 'adjust_duration';
}

export const scheduleResultLabel: Record<ScheduleResult, string> = {
  unconfirmed: '未確認',
  completed: '完了',
  not_done: '未実行',
  cancelled: 'キャンセル',
  skipped: '見送り',
};

export const scheduleOperationLabel: Record<ScheduleOperation, string> = {
  schedule: '新規予定',
  reschedule: '再予定',
  adjust_date: '日付変更',
  adjust_time: '時刻変更',
  adjust_duration: '予定時間変更',
  unschedule: '予定解除',
  set_result: '結果記録',
  correct_result: '結果訂正',
  revert: '変更取消',
  reapply: '変更再適用',
  resolve_conflict: '競合解決',
};

export function scheduleHistoryDates(entry: ScheduleHistoryEntry): string[] {
  return [...new Set([
    entry.before?.scheduledDate,
    entry.after?.scheduledDate,
  ].filter((value): value is string => Boolean(value)))];
}

export function latestResultsByVersion(entries: ScheduleHistoryEntry[]): Map<string, ScheduleResult> {
  const controls = new Map<string, 'revert' | 'reapply'>();
  [...entries]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .forEach((entry) => {
      if (entry.relatedEntryId && (entry.operation === 'revert' || entry.operation === 'reapply')) {
        controls.set(entry.relatedEntryId, entry.operation);
      }
    });
  const results = new Map<string, ScheduleResult>();
  [...entries]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .forEach((entry) => {
      if (
        entry.targetVersionId
        && (entry.operation === 'set_result' || entry.operation === 'correct_result')
        && controls.get(entry.id) !== 'revert'
      ) {
        results.set(entry.targetVersionId, entry.result);
      }
    });
  return results;
}

export function effectiveScheduleChanges(entries: ScheduleHistoryEntry[]): ScheduleHistoryEntry[] {
  const controls = new Map<string, 'revert' | 'reapply'>();
  [...entries]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .forEach((entry) => {
      if (entry.relatedEntryId && (entry.operation === 'revert' || entry.operation === 'reapply')) {
        controls.set(entry.relatedEntryId, entry.operation);
      }
    });
  return entries.filter((entry) =>
    !['set_result', 'correct_result', 'revert', 'reapply'].includes(entry.operation)
    && controls.get(entry.id) !== 'revert'
  );
}
