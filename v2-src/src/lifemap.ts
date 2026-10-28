import { createMemo, updateMemo } from './store';
import { sessionActiveSeconds } from './insights';
import type { AreaKey, FocusSession, LifeEntry, Memo, Task } from './types';

/**
 * 人生の地図のデータ：章・出来事・これからの目印、月1回の領域の点、大事にしたい順。
 * どれも同期されるメモとして持つ（どの端末でも同じ地図）。
 */
export const LIFE_CATEGORY = '人生の地図';
export const LIFE_YEARS = 80;
export const CHAPTER_COLORS = ['#378ADD', '#7F77DD', '#1D9E75', '#D85A30', '#D4537E', '#BA7517', '#5F5E5A'];

const live = (memos: Memo[]) => memos.filter((m) => !m.deletedAt && !m.archived && m.category === LIFE_CATEGORY);

export function lifeEntries(memos: Memo[]): Memo[] {
  return live(memos).filter((m) => m.life).sort((a, b) => a.life!.from.localeCompare(b.life!.from));
}

export async function saveLifeEntry(entry: LifeEntry, existing?: Memo): Promise<Memo | null> {
  const life: LifeEntry = { ...entry, title: entry.title.trim().slice(0, 40), note: entry.note?.trim().slice(0, 300) || '' };
  if (!life.title || !/^\d{4}-\d{2}$/.test(life.from)) throw new Error('名前と、いつ（年と月）を入れてください');
  const title = `${life.kind === 'chapter' ? '章' : life.kind === 'event' ? '出来事' : '目印'}：${life.title}`;
  if (existing) return updateMemo(existing.id, { life, title }, '人生の地図を直す');
  return createMemo({ title, body: '', category: LIFE_CATEGORY, life });
}

export async function removeLifeEntry(memo: Memo): Promise<void> {
  await updateMemo(memo.id, { deletedAt: new Date().toISOString(), archived: true }, '人生の地図から消す');
}

/** 年月 → 生まれてから何週目か。 */
export function weekIndex(birthday: string, ym: string): number {
  const b = new Date(`${birthday}T00:00:00`);
  const [y, m] = ym.split('-').map(Number);
  return Math.max(0, Math.floor((new Date(y, m - 1, 1).getTime() - b.getTime()) / (7 * 86_400_000)));
}

export function weeksLived(birthday: string, now = new Date()): number {
  const b = new Date(`${birthday}T00:00:00`);
  return Math.max(0, Math.floor((now.getTime() - b.getTime()) / (7 * 86_400_000)));
}

export function currentChapter(memos: Memo[], now = new Date()): Memo | null {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const chapters = lifeEntries(memos).filter((m) => m.life!.kind === 'chapter' && m.life!.from <= ym && (!m.life!.to || m.life!.to >= ym));
  return chapters[chapters.length - 1] || null;
}

// ---- 領域の点（月1回） ----
export function scoreFor(memos: Memo[], month: string): Memo | null {
  return live(memos).filter((m) => m.areaScore?.month === month).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
}

export async function saveScores(memos: Memo[], month: string, scores: Partial<Record<AreaKey, number>>): Promise<void> {
  const existing = scoreFor(memos, month);
  if (existing) await updateMemo(existing.id, { areaScore: { month, scores } }, '領域の点を直す');
  else await createMemo({ title: `領域の点：${month}`, body: '', category: LIFE_CATEGORY, areaScore: { month, scores } });
}

// ---- 大事にしたい順 ----
export const DEFAULT_VALUES: AreaKey[] = ['health', 'family', 'work', 'money', 'people', 'fun'];
export function valuesOf(memos: Memo[]): { memo: Memo | null; order: AreaKey[] } {
  const memo = live(memos).filter((m) => Array.isArray(m.values)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  const order = memo?.values?.length ? memo.values : DEFAULT_VALUES;
  return { memo, order: [...order, ...DEFAULT_VALUES.filter((k) => !order.includes(k))] };
}
export async function saveValues(memos: Memo[], order: AreaKey[]): Promise<void> {
  const { memo } = valuesOf(memos);
  if (memo) await updateMemo(memo.id, { values: order }, '大事にしたい順を変える');
  else await createMemo({ title: '大事にしたい順', body: '', category: LIFE_CATEGORY, values: order });
}

// ---- 時間の行き先（今月）：タスクの名前から領域を推して、作業した時間を足す ----
const AREA_WORDS: [AreaKey, RegExp][] = [
  ['health', /運動|筋トレ|散歩|ストレッチ|病院|通院|歯医者|歯磨き|薬|シャワー|風呂|ドライヤー|睡眠|寝る|ヨガ|ジム|体重|健康|水虫|ご飯|朝ごはん|昼ごはん|料理/],
  ['family', /母|父|親|家族|実家|兄|姉|弟|妹|祖|墓|親戚/],
  ['people', /友|飲み会|会食|ライブ|会う|遊ぶ|連絡|LINE|電話|誕生日|プレゼント|ボーイスカウト|団会議/],
  ['money', /支払|振込|保険|銀行|家計|奨学金|税|確定申告|口座|カード|予算|節約/],
  ['fun', /趣味|映画|ゲーム|読書|旅行|音楽|動画|アニメ|カメラ|散策|カフェ|アプリ作り|ガジェット/],
];
export function areaOfTask(task: Task): AreaKey {
  const text = `${task.title} ${task.notes || ''} ${task.routine?.name || ''}`;
  for (const [key, re] of AREA_WORDS) if (re.test(text)) return key;
  return 'work';
}

export function timeByArea(tasks: Task[], sessions: FocusSession[], month: string): Record<AreaKey, number> {
  const out: Record<AreaKey, number> = { health: 0, family: 0, work: 0, money: 0, people: 0, fun: 0 };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const s of sessions) {
    if (s.deletedAt || !s.endedAt || !s.startedAt.startsWith(month.slice(0, 4))) continue;
    const d = new Date(s.startedAt);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (ym !== month) continue;
    const task = byId.get(s.taskId);
    if (!task) continue;
    out[areaOfTask(task)] += Math.round((sessionActiveSeconds(s) || 0) / 60);
  }
  return out;
}
