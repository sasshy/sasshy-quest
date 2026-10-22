import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { completeTask } from './store';
import { DEFAULT_ROUTINES, getRoutines, nextRoutineTask, parseRoutineSteps, routineStepsText, saveRoutines, startRoutine } from './routines';

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
    expect(parseRoutineSteps(routineStepsText(DEFAULT_ROUTINES[0].steps))).toEqual(DEFAULT_ROUTINES[0].steps);
  });

  it('starts the first step and lines up the rest ahead of other tasks', async () => {
    const { tasks, session } = await startRoutine(DEFAULT_ROUTINES[0]);
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
