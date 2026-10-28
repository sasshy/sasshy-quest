import { db, makeId } from './db';
import { usualMinutes } from './insights';
import { createTask, startFocusSession, updateTask } from './store';
import { workDayKey } from './dayline';
import type { FocusSession, Task } from './types';
import { localDateKey } from './work-start';

/**
 * Routines: a saved list of short, familiar steps (e.g. the night routine that
 * worked well: one step at a time with a voice countdown). Starting one adds
 * all steps to today and starts the first; completing a step starts the next.
 * Stored on this device (settings), like the lunch reminder.
 */
export interface RoutineStep { title: string; minutes: number }
export interface Routine { id: string; name: string; steps: RoutineStep[] }
interface RoutineSetting { id: 'routines'; list: Routine[]; offered?: string[] }

export const DEFAULT_ROUTINES: Routine[] = [
  {
    id: 'morning',
    name: '朝ルーティン',
    steps: [
      { title: '水を1杯飲む', minutes: 1 },
      { title: '顔を洗う・歯磨き', minutes: 5 },
      { title: '着替える', minutes: 5 },
      { title: '朝ごはん', minutes: 10 },
      { title: '鍵・財布・スマホを確認して出る', minutes: 3 },
    ],
  },
  {
    id: 'noon',
    name: '昼リセット',
    steps: [
      { title: '昼ごはん（記録もする）', minutes: 30 },
      { title: '外の空気を吸う・少し歩く', minutes: 5 },
      { title: '午後の1つ目を決める', minutes: 2 },
    ],
  },
  {
    id: 'night',
    name: '夜ルーティン',
    steps: [
      { title: 'シャワー', minutes: 15 },
      { title: 'ドライヤー', minutes: 5 },
      { title: '歯磨き', minutes: 3 },
      { title: 'スラックスの汚れ落とし', minutes: 5 },
      { title: '明日の準備', minutes: 5 },
    ],
  },
  {
    id: 'leave-work',
    name: '退社前',
    steps: [
      { title: '出しっぱなしを戻す', minutes: 10 },
      { title: '明日やることを1つ書く', minutes: 2 },
      { title: '荷物をまとめて出る', minutes: 3 },
    ],
  },
];

/** Routines that existed before 朝/昼 were added; a saved list already "knows" these. */
const FIRST_DEFAULTS = ['night', 'leave-work'];

/**
 * Saved list + defaults the user has never been offered (so new templates like
 * 朝ルーティン show up once, and stay gone if the user deletes them).
 */
export function mergeRoutines(saved: RoutineSetting | undefined): Routine[] {
  if (!saved?.list?.length) return DEFAULT_ROUTINES;
  const offered = new Set(saved.offered || FIRST_DEFAULTS);
  const fresh = DEFAULT_ROUTINES.filter((r) => !offered.has(r.id) && !saved.list.some((x) => x.id === r.id));
  const order = (r: Routine) => DEFAULT_ROUTINES.findIndex((d) => d.id === r.id);
  return [...saved.list, ...fresh].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x === -1 || y === -1 ? 0 : x - y;
  });
}

export async function getRoutines(): Promise<Routine[]> {
  return mergeRoutines((await db.settings.get('routines')) as unknown as RoutineSetting | undefined);
}

export async function saveRoutines(list: Routine[]): Promise<void> {
  const offered = DEFAULT_ROUTINES.map((r) => r.id);
  await db.settings.put({ id: 'routines', list, offered } as unknown as import('./types').AppSetting);
}

/** "シャワー 15" per line (minutes optional, default 5). */
export function parseRoutineSteps(text: string): RoutineStep[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*?)[\s　]*(\d{1,3})\s*分?$/.exec(line);
      const title = (match ? match[1] : line).trim() || line;
      const minutes = match ? Math.min(240, Math.max(1, Number(match[2]))) : 5;
      return { title, minutes };
    });
}

export function routineStepsText(steps: RoutineStep[]): string {
  return steps.map((step) => `${step.title} ${step.minutes}`).join('\n');
}

/** Add all steps to today (ahead of other tasks) and start the first one. */
export async function startRoutine(routine: Routine, now = new Date()): Promise<{ tasks: Task[]; session: FocusSession | null }> {
  if (!routine.steps.length) return { tasks: [], session: null };
  // 夜中4時までは前の日のルーティン（夜ルーティンを0時すぎに始めても、その夜の分）。
  const today = workDayKey(now.toISOString());
  // 連打や二重起動で同じルーティンが何組もできないように、今日の途中のものがあれば続きから。
  const unfinished = (await db.tasks.toArray())
    .filter((t) => t.routine?.name === routine.name && t.scheduledDate === today && !t.deletedAt && t.status !== 'done' && t.status !== 'archived')
    .sort((a, b) => a.routine!.index - b.routine!.index);
  if (unfinished.length) {
    const session = await startFocusSession(unfinished[0], usualMinutes(unfinished[0], await db.sessions.toArray()).minutes);
    return { tasks: unfinished, session };
  }
  const runId = makeId('routine-run');
  const tasks: Task[] = [];
  for (const [index, step] of routine.steps.entries()) {
    tasks.push(await createTask({
      title: step.title,
      notes: `ルーティン：${routine.name}`,
      scheduledDate: today,
      estimateMin: step.minutes,
      durationMin: step.minutes,
      flowOrder: -1000 + index,
      routine: { runId, name: routine.name, index, count: routine.steps.length },
    }));
  }
  const session = await startFocusSession(tasks[0], usualMinutes(tasks[0], await db.sessions.toArray()).minutes);
  return { tasks, session };
}

/** The next not-yet-done step of the same routine run, if any. */
export async function nextRoutineTask(task: Task | undefined): Promise<Task | null> {
  if (!task?.routine) return null;
  const { runId, index } = task.routine;
  const siblings = (await db.tasks.toArray())
    .filter((t) => t.routine?.runId === runId && t.routine.index > index && !t.deletedAt && t.status !== 'done' && t.status !== 'archived')
    .sort((a, b) => a.routine!.index - b.routine!.index);
  return siblings[0] || null;
}

/**
 * 1回だけ：前に0時すぎに始めた夜ルーティンが「次の日」の予定になっていたのを、
 * その夜の日付に戻す（月表示の今日に、昨夜の分が出ていた）。
 */
export async function fixLateRoutineDatesOnce(): Promise<number> {
  const KEY = 'sasshy-fix-late-routine';
  try {
    if (localStorage.getItem(KEY)) return 0;
    localStorage.setItem(KEY, '1');
  } catch {
    return 0;
  }
  let n = 0;
  for (const t of await db.tasks.toArray()) {
    if (!t.routine || t.deletedAt || !t.scheduledDate) continue;
    const created = new Date(t.createdAt);
    if (created.getHours() >= 4) continue;
    const day = workDayKey(t.createdAt);
    if (t.scheduledDate !== day && t.scheduledDate === localDateKey(created)) {
      await updateTask(t.id, { scheduledDate: day }, 'ルーティンの日付を夜の日付に直す', false);
      n += 1;
    }
  }
  return n;
}

/**
 * 手順つきのタスクを始める：手順を1つずつのタスクにして（ルーティンと同じ流れ）、
 * 元のタスクは手順が全部終わるまで一覧から外しておく。すでに始めていれば続きから。
 */
export async function expandTaskSteps(task: Task, now = new Date()): Promise<Task | null> {
  const steps = (task.steps || []).filter((s) => s.title.trim());
  if (!steps.length) return null;
  const existing = (await db.tasks.toArray())
    .filter((t) => t.routine?.parentId === task.id && !t.deletedAt && t.status !== 'done' && t.status !== 'archived')
    .sort((a, b) => a.routine!.index - b.routine!.index);
  if (existing.length) return existing[0];
  const runId = makeId('steps-run');
  const day = task.scheduledDate && task.scheduledDate >= workDayKey(now.toISOString()) ? task.scheduledDate : workDayKey(now.toISOString());
  let first: Task | null = null;
  for (const [index, step] of steps.entries()) {
    const created = await createTask({
      title: step.title.trim(),
      notes: `手順：${task.title}`,
      scheduledDate: day,
      estimateMin: Math.max(1, step.minutes || 5),
      durationMin: Math.max(1, step.minutes || 5),
      flowOrder: (task.flowOrder ?? 0) - 100 + index / 100,
      routine: { runId, name: task.title, index, count: steps.length, parentId: task.id },
    });
    if (!first) first = created;
  }
  await updateTask(task.id, { status: 'archived' }, `「${task.title}」を手順に分けて始める`);
  return first;
}
