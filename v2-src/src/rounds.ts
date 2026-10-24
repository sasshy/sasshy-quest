import { db } from './db';
import { createTask, startFocusSession, updateSession } from './store';
import { localDateKey } from './meals';
import type { FocusSession, Task } from './types';

/**
 * Long tasks run as 15-minute rounds: each round is its own session (so the
 * countdown and the alarm are never longer than 15 minutes, and the record is
 * cut every 15 minutes). The task itself stays one task.
 */
export const ROUND_MIN = 15;

export function usesRounds(task: Task): boolean {
  return !task.routine && !task.log && task.estimateMin > ROUND_MIN;
}

/** Planned minutes (on top of earlier work) and the round info for the next round. */
export function nextRound(task: Task, carriedElapsedSec: number, plan = ''): { plannedMin: number; round: NonNullable<FocusSession['round']> } {
  const doneMin = Math.max(0, carriedElapsedSec) / 60;
  const leftMin = task.estimateMin - doneMin;
  const lengthMin = leftMin >= 5 && leftMin < ROUND_MIN ? Math.ceil(leftMin) : ROUND_MIN;
  const index = Math.floor(doneMin / ROUND_MIN) + 1;
  const total = Math.max(index, Math.ceil(task.estimateMin / ROUND_MIN));
  return { plannedMin: Math.ceil(doneMin) + lengthMin, round: { index, total, plan: plan.trim().slice(0, 80) } };
}

const normalize = (title: string) => title.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/**
 * What to do in the next round: the unfinished plan first, then the steps used
 * the last times this kind of task was done (in their usual order).
 * This is how "いつもの手順" is learned without typing anything extra.
 */
export async function planSuggestions(task: Task, current: FocusSession | null, limit = 4): Promise<string[]> {
  const out: string[] = [];
  const push = (p: string | undefined) => {
    const v = (p || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  if (current?.round?.plan && current.round.result !== 'done') push(current.round.plan);
  const key = normalize(task.title);
  const sameTasks = new Set((await db.tasks.toArray()).filter((t) => !t.deletedAt && normalize(t.title) === key).map((t) => t.id));
  const past = (await db.sessions.toArray())
    .filter((s) => !s.deletedAt && sameTasks.has(s.taskId) && s.round?.plan)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const donePlans = new Set(
    past.filter((s) => s.taskId === task.id && s.round?.result === 'done').map((s) => s.round!.plan.trim()),
  );
  // 前回までの同じ作業の手順を、ラウンド順に。今回もう済んだものは出さない。
  const byIndex = [...past].sort((a, b) => a.round!.index - b.round!.index || a.startedAt.localeCompare(b.startedAt));
  for (const s of byIndex) {
    if (out.length >= limit) break;
    if (donePlans.has(s.round!.plan.trim())) continue;
    if (current && s.id === current.id) continue;
    push(s.round!.plan);
  }
  return out.slice(0, limit);
}

/** A short break between rounds (kept on this device). */
export interface RoundBreak { id: 'roundBreak'; taskId: string; title: string; until: string; plan: string }

export async function getRoundBreak(): Promise<RoundBreak | null> {
  const v = (await db.settings.get('roundBreak')) as unknown as RoundBreak | undefined;
  return v?.taskId ? v : null;
}

export async function setRoundBreak(value: Omit<RoundBreak, 'id'> | null): Promise<void> {
  if (!value) await db.settings.delete('roundBreak');
  else await db.settings.put({ id: 'roundBreak', ...value } as unknown as import('./types').AppSetting);
}

export const INTERRUPT_CHOICES = ['電話', 'お客さん', '急ぎの出荷', 'kintone確認', '別の仕事', 'トイレ・休憩'];
export const DETOUR_CHOICES = ['X', 'YouTube', 'Kindle', 'その他'];

/**
 * Begin an interruption / detour at a given time (from the iPhone Shortcuts
 * automation, which noted when X / YouTube / kintone was opened). The current
 * work ends at that moment and the detour is timed from then, so the day's
 * record shows it; coming back offers 続きから.
 */
export async function startInterruptAt(kind: 'interrupt' | 'detour', label: string, at: number): Promise<FocusSession | null> {
  const running = (await db.sessions.where('status').equals('running').toArray())
    .filter((s) => !s.deletedAt && !s.interrupt && Date.parse(s.startedAt) <= at)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!running) return null;
  const elapsed = Math.floor((at - Date.parse(running.startedAt)) / 1000) - running.pausedTotalSec + (running.carriedElapsedSec || 0);
  const leftMin = Math.max(1, Math.ceil((running.plannedMin * 60 - elapsed) / 60));
  const task = await createTask({
    title: `${kind === 'interrupt' ? '割り込み' : '寄り道'}：${label}`,
    notes: `「${running.taskTitle}」の途中`,
    scheduledDate: localDateKey(at),
    estimateMin: kind === 'detour' ? 5 : 10,
    durationMin: kind === 'detour' ? 5 : 10,
    log: kind,
  });
  const detour = await startFocusSession(task, kind === 'detour' ? 5 : 10, 0, {
    interrupt: { kind, returnTaskId: running.taskId, returnTitle: running.taskTitle, returnLeftMin: leftMin, returnPlan: running.round?.plan || '' },
  });
  const atIso = new Date(at).toISOString();
  // 開始と終了を、実際にアプリを開いた時刻に合わせる。
  await updateSession(running.id, { endedAt: atIso }, `${label}を開いたところで区切る`);
  return updateSession(detour.id, { startedAt: atIso }, `${label}を開いた時刻から`);
}

/** kintone など仕事のアプリは「割り込み」、それ以外は「寄り道」。 */
export function detourKind(app: string): 'interrupt' | 'detour' {
  return /kintone|キントーン|メール|mail|slack|teams|電話|phone/i.test(app) ? 'interrupt' : 'detour';
}
