import { db } from './db';
import { updateTask } from './store';
import type { Task } from './types';
import { localDateKey } from './work-start';

/**
 * やることが溜まって見なくなるのを防ぐ：上には3件だけ、残りはたたむ。
 * 30日さわらなかったものは消さずに「いつか」へ移す。週に1回だけ片付けに誘う。
 */
export const STALE_DAYS = 30;
const DAY = 86_400_000;

/** 日付のない「今」のやること（寄り道の記録などは除く）。 */
export function inboxTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.deletedAt && !t.log && t.status !== 'done' && t.status !== 'archived' && !t.scheduledDate && t.horizon === 'now');
}

export const ageDays = (task: Task, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(task.createdAt)) / DAY));

/** 上に出す3件：急ぎ・大事を先に、同じなら古いもの（忘れられやすい）から。 */
export function pickTop(tasks: Task[], count = 3): Task[] {
  const score = (t: Task) => t.urgency * 4 + t.importance * 3;
  return [...tasks].sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt)).slice(0, count);
}

/** 30日さわっていない日付なしのやることを「いつか」へ（消さない）。移した件数を返す。 */
export async function moveStaleToSomeday(now = Date.now()): Promise<number> {
  const stale = inboxTasks(await db.tasks.toArray()).filter((t) => now - Date.parse(t.updatedAt) >= STALE_DAYS * DAY);
  for (const t of stale) await updateTask(t.id, { horizon: 'someday' }, `${STALE_DAYS}日さわらなかったので「いつか」へ`);
  return stale.length;
}

const LAST_TRIAGE = 'sasshy-last-triage';
export function markTriaged(): void {
  try { localStorage.setItem(LAST_TRIAGE, String(Date.now())); } catch { /* なくても動く */ }
}

/** 今日の画面に「片付けよう」を出すか：8件以上溜まっていて、前回から7日以上。 */
export function shouldNudgeTriage(count: number, now = Date.now()): boolean {
  if (count < 8) return false;
  let last = 0;
  try { last = Number(localStorage.getItem(LAST_TRIAGE)) || 0; } catch { /* 初回扱い */ }
  return now - last >= 7 * DAY;
}

/** 1日1回だけ、古いものを「いつか」へ。 */
export async function dailyTidy(now = Date.now()): Promise<number> {
  const KEY = 'sasshy-tidy-day';
  const today = localDateKey(new Date(now));
  try {
    if (localStorage.getItem(KEY) === today) return 0;
    localStorage.setItem(KEY, today);
  } catch {
    return 0;
  }
  return moveStaleToSomeday(now);
}
