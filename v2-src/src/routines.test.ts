import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { completeTask } from './store';
import { DEFAULT_ROUTINES, getRoutines, mergeRoutines, nextRoutineTask, parseRoutineSteps, routineStepsText, saveRoutines, startRoutine } from './routines';

const NIGHT = DEFAULT_ROUTINES.find((r) => r.id === 'night')!;

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
});

describe('routines', () => {
  it('parses "やること 分" lines (minutes optional)', () => {
    expect(parseRoutineSteps('シャワー 15\nドライヤー　5分\n\n歯磨き')).toEqual([
      { title: 'シャワー', minutes: 15 },
      { title: 'ドライヤー', minutes: 5 },
      { title: '歯磨き', minutes: 5 },
    ]);
    expect(parseRoutineSteps(routineStepsText(NIGHT.steps))).toEqual(NIGHT.steps);
  });

  it('starts the first step and lines up the rest ahead of other tasks', async () => {
    const { tasks, session } = await startRoutine(NIGHT);
    expect(tasks.map((t) => t.title)).toEqual(['シャワー', 'ドライヤー', '歯磨き', 'スラックスの汚れ落とし', '明日の準備']);
    expect(tasks.every((t) => t.flowOrder! < 0 && t.scheduledDate)).toBe(true);
    expect(session?.taskId).toBe(tasks[0].id);
    expect(session?.plannedMin).toBe(15);
  });

  it('the next step follows completion, and stops at the end', async () => {
    const { tasks } = await startRoutine({ id: 'x', name: 'テスト', steps: [{ title: 'A', minutes: 1 }, { title: 'B', minutes: 2 }] });
    expect((await nextRoutineTask(tasks[0]))?.title).toBe('B');
    await completeTask(tasks[1].id, true);
    expect(await nextRoutineTask(tasks[0])).toBeNull();
  });

  it('keeps edited routines on this device', async () => {
    await saveRoutines([{ id: 'r', name: '朝', steps: [{ title: '顔を洗う', minutes: 2 }] }]);
    expect((await getRoutines()).map((r) => r.name)).toEqual(['朝']);
  });
});

describe('routine started twice', () => {
  it('continues the unfinished run instead of adding another set', async () => {
    const first = await startRoutine(DEFAULT_ROUTINES.find((r) => r.id === 'leave-work')!);
    const again = await startRoutine(DEFAULT_ROUTINES.find((r) => r.id === 'leave-work')!);
    expect(again.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
    expect((await db.tasks.toArray()).filter((t) => t.routine?.name === '退社前')).toHaveLength(3);
  });

  it('offers new templates (朝・昼) once to a saved list, and respects deletion afterwards', async () => {
    const custom = { ...NIGHT, steps: [{ title: '歯磨き', minutes: 3 }] };
    const old = mergeRoutines({ id: 'routines', list: [custom] });
    expect(old.map((r) => r.id)).toEqual(['morning', 'noon', 'night']);
    expect(old.find((r) => r.id === 'night')!.steps).toHaveLength(1);
    await saveRoutines([custom]);
    expect((await getRoutines()).map((r) => r.id)).toEqual(['night']);
  });
});
