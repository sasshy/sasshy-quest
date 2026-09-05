// Pure policy shared by the browser and the background dispatcher. All times are JST.
export interface WorkReminder {
  dueDate?: string | null;
  dueTime?: string | null;
  reminderEnabled?: boolean;
  reminderAfter?: string | null;
  createdAt?: string;
  status?: string;
  deletedAt?: string | null;
}
const HOUR = 3_600_000;
export function workReminderSlot(task: WorkReminder, now: number): number | null {
  if (!task.reminderEnabled || task.deletedAt || ['done', 'archived', 'active'].includes(task.status || '')) return null;
  const jst = new Date(now + 9 * HOUR);
  const hour = jst.getUTCHours();
  if ([0, 6].includes(jst.getUTCDay()) || hour < 9 || hour >= 18) return null;
  const due = task.dueDate ? Date.parse(`${task.dueDate}T${task.dueTime || '17:00'}:00+09:00`) : Date.parse(task.createdAt || '') + HOUR;
  const snooze = task.reminderAfter ? Date.parse(task.reminderAfter) : 0;
  if (!Number.isFinite(due) || !Number.isFinite(snooze)) return null;
  const base = Math.max(due, snooze);
  if (now < base) return null;
  // Anchor to each workday; delayed cron runs catch up once, never send a backlog.
  const dayStart = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()); // 09:00 JST
  const first = Math.max(dayStart, base);
  return first + Math.floor((now - first) / HOUR) * HOUR;
}
