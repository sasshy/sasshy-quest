import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { getBudget, type BudgetSetting } from "./budget";
import type { Memo } from "./types";

/**
 * 記録（メモ）と予算設定の読み込み。読み込み中は undefined を返し、空の配列と区別する。
 * 空のまま計算すると「使った ¥0」などの間違った数字が一瞬〜数秒出てしまう（iPhoneは読み込みが遅い）。
 * 一度読めた値は覚えておき、画面を切り替えても読み込み中に戻らないようにする。
 */
let lastMemos: Memo[] | undefined;
let lastBudget: BudgetSetting | undefined;

export function useMemos(): Memo[] | undefined {
  const memos = useLiveQuery(() => db.memos.toArray(), []);
  if (memos) lastMemos = memos;
  return memos ?? lastMemos;
}

export function useBudgetSetting(): BudgetSetting | undefined {
  const setting = useLiveQuery(async () => {
    await db.settings.get("budget");
    return getBudget();
  }, []);
  if (setting) lastBudget = setting;
  return setting ?? lastBudget;
}
