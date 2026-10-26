import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureDefaults } from './db';
import { createTask } from './store';
import { inboxTasks, moveStaleToSomeday, pickTop, shouldNudgeTriage } from './triage';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureDefaults();
  localStorage.clear();
});

describe('やることの片付け', () => {
  it('上に出すのは急ぎ・大事を先に3件、同じなら古い順', async () => {
    const a = await createTask({ title: 'A' });
    await createTask({ title: 'B' });
    const c = await createTask({ title: 'C', urgency: 2 });
    await createTask({ title: 'D' });
    const top = pickTop(inboxTasks(await db.tasks.toArray()));
    expect(top.map((t) => t.title)).toEqual(['C', 'A', 'B']);
    expect(top[0].id).toBe(c.id);
    expect(top[1].id).toBe(a.id);
  });
  it('30日さわらなかったものは「いつか」へ（消さない）', async () => {
    const old = await createTask({ title: '古い' });
    await createTask({ title: '新しい' });
    await db.tasks.update(old.id, { updatedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() });
    expect(await moveStaleToSomeday()).toBe(1);
    const moved = await db.tasks.get(old.id);
    expect(moved?.horizon).toBe('someday');
    expect(moved?.deletedAt).toBeFalsy();
  });
  it('8件以上で、前回の片付けから7日以上なら誘う', () => {
    expect(shouldNudgeTriage(7)).toBe(false);
    expect(shouldNudgeTriage(8)).toBe(true);
    localStorage.setItem('sasshy-last-triage', String(Date.now()));
    expect(shouldNudgeTriage(20)).toBe(false);
  });
});
