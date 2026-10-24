import { db, makeId } from './db';
import { createTask, startFocusSession } from './store';
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
interface RoutineSetting { id: 'routines'; list: Routine[] }

export const DEFAULT_ROUTINES: Routine[] = [
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

export async function getRoutines(): Promise<Routine[]> {
  const saved = (await db.settings.get('routines')) as unknown as RoutineSetting | undefined;
  return saved?.list?.length ? saved.list : DEFAULT_ROUTINES;
}

export async function saveRoutines(list: Routine[]): Promise<void> {
  await db.settings.put({ id: 'routines', list } as unknown as import('./types').AppSetting);
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
  const today = localDateKey(now);
  // 連打や二重起動で同じルーティンが何組もできないように、今日の途中のものがあれば続きから。
  const unfinished = (await db.tasks.toArray())
    .filter((t) => t.routine?.name === routine.name && t.scheduledDate === today && !t.deletedAt && t.status !== 'done')
    .sort((a, b) => a.routine!.index - b.routine!.index);
  if (unfinished.length) {
    const session = await startFocusSession(unfinished[0], unfinished[0].estimateMin);
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
  const session = await startFocusSession(tasks[0], tasks[0].estimateMin);
  return { tasks, session };
}

/** The next not-yet-done step of the same routine run, if any. */
export async function nextRoutineTask(task: Task | undefined): Promise<Task | null> {
  if (!task?.routine) return null;
  const { runId, index } = task.routine;
  const siblings = (await db.tasks.toArray())
    .filter((t) => t.routine?.runId === runId && t.routine.index > index && !t.deletedAt && t.status !== 'done')
    .sort((a, b) => a.routine!.index - b.routine!.index);
  return siblings[0] || null;
}
