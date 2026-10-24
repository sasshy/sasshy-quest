import { db } from './db';
import { createMemo, updateMemo } from './store';
import type { ExpenseInfo, MealInfo, MealKind, MealPayment, Memo } from './types';

/**
 * Quick meal/snack records. Stored as memos (category '食事' + `meal`) so they
 * sync through the existing per-record sync without any server change.
 */
export const MEAL_CATEGORY = '食事';

export const MEAL_LABEL: Record<MealKind, string> = {
  breakfast: '朝食',
  lunch: '昼食',
  dinner: '夕食',
  snack: '間食',
};

export function isMealMemo(memo: Memo): boolean {
  return memo.category === MEAL_CATEGORY && Boolean(memo.meal);
}

export const EXPENSE_CATEGORY = '支出';

export function isExpenseMemo(memo: Memo): boolean {
  return memo.category === EXPENSE_CATEGORY && Boolean(memo.expense) && Number.isFinite(Number(memo.expense!.amount));
}

/** Meal and spend records live in the meal sheet, not in the normal memo list. */
export function isLedgerMemo(memo: Memo): boolean {
  return isMealMemo(memo) || isExpenseMemo(memo) || (memo.category === '支出予定' && Boolean(memo.planned));
}

export function localDateKey(at: string | number | Date): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Guess what is being recorded from the time of day. */
export function suggestKind(now = new Date()): MealKind {
  const h = now.getHours() + now.getMinutes() / 60;
  if (h >= 4 && h < 10) return 'breakfast';
  if (h >= 10.5 && h < 14.5) return 'lunch';
  if (h >= 17.5 && h < 22) return 'dinner';
  return 'snack';
}

export function mealsOn(memos: Memo[], dateKey: string): Memo[] {
  return memos
    .filter((m) => !m.deletedAt && !m.archived && isMealMemo(m) && localDateKey(m.meal!.at) === dateKey)
    .sort((a, b) => Date.parse(a.meal!.at) - Date.parse(b.meal!.at));
}

export function kcalOn(memos: Memo[], dateKey: string): number {
  return mealsOn(memos, dateKey).reduce((sum, m) => sum + (m.meal!.kcal || 0), 0);
}

export const PAYMENT_LABEL: Record<MealPayment, string> = {
  self: '自分で払った',
  treated: 'おごってもらった',
  split: '割り勘',
  paid_for_others: '自分がおごった',
  home: '家で食べた（お金なし）',
};

/** The amount that left the user's wallet (falls back to price). */
export function paidAmount(meal: MealInfo): number {
  if (meal.paid !== undefined && meal.paid !== null) return meal.paid;
  if (meal.payment === 'treated' || meal.payment === 'home') return 0;
  return meal.price || 0;
}

/** Household spend for the day = what was actually paid. */
export function spendOn(memos: Memo[], dateKey: string): number {
  return mealsOn(memos, dateKey).reduce((sum, m) => sum + paidAmount(m.meal!), 0);
}

/** Sum of meal prices (value eaten), regardless of who paid. */
export function valueOn(memos: Memo[], dateKey: string): number {
  return mealsOn(memos, dateKey).reduce((sum, m) => sum + (m.meal!.price || 0), 0);
}

export function expensesOn(memos: Memo[], dateKey: string): Memo[] {
  return memos
    .filter((m) => !m.deletedAt && !m.archived && isExpenseMemo(m) && localDateKey(m.expense!.at) === dateKey)
    .sort((a, b) => Date.parse(a.expense!.at) - Date.parse(b.expense!.at));
}

export function expenseTotalOn(memos: Memo[], dateKey: string): number {
  return expensesOn(memos, dateKey).reduce((sum, m) => sum + Number(m.expense!.amount || 0), 0);
}

/** Everything that left the wallet that day: meals (paid amount) + other spends. Each record counted once. */
export function walletOn(memos: Memo[], dateKey: string): number {
  return spendOn(memos, dateKey) + expenseTotalOn(memos, dateKey);
}

/** Meals and spends of a day in time order, for the day view. */
export function ledgerOn(memos: Memo[], dateKey: string): Memo[] {
  const at = (m: Memo) => Date.parse(m.meal?.at || m.expense?.at || m.createdAt);
  return [...mealsOn(memos, dateKey), ...expensesOn(memos, dateKey)].sort((a, b) => at(a) - at(b));
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return localDateKey(new Date(y, m - 1, d + days, 12));
}

export interface ExpenseInput { item: string; amount: number | null; at?: string }

export async function recordExpense(input: ExpenseInput): Promise<Memo> {
  const item = input.item.trim();
  if (!item) throw new Error('何に使ったかを入力してください');
  const amount = cleanNumber(input.amount);
  if (amount === null) throw new Error('金額を入力してください');
  const expense: ExpenseInfo = { item, amount, at: input.at || new Date().toISOString(), source: 'app' };
  return createMemo({
    title: `支出：${item} ¥${amount.toLocaleString('ja-JP')}`,
    body: '',
    category: EXPENSE_CATEGORY,
    expense,
  });
}

export function hasKindOn(memos: Memo[], dateKey: string, kind: MealKind): boolean {
  return mealsOn(memos, dateKey).some((m) => m.meal!.kind === kind);
}

export interface MealFavorite extends MealNutrition { item: string; kind: MealKind; price: number | null; count: number; place?: string | null }
export interface MealNutrition { kcal?: number | null; protein?: number | null; fat?: number | null; carbs?: number | null }
const nutritionOf = (meal: MealInfo): MealNutrition & { place: string | null } => ({ kcal: meal.kcal ?? null, protein: meal.protein ?? null, fat: meal.fat ?? null, carbs: meal.carbs ?? null, place: meal.place ?? null });

export interface FavoriteOptions {
  /** Prefer items eaten as this meal. Falls back to all meals when there are too few. */
  kind?: MealKind;
  /** Items eaten only once (e.g. a whole home-dinner menu) are not favorites. */
  minCount?: number;
  /** Long names (combined menus) make messy buttons. */
  maxLength?: number;
}

/** Most frequent items of the last 60 days, with the price paid last time. */
export function mealFavorites(memos: Memo[], now = Date.now(), limit = 6, options: FavoriteOptions = {}): MealFavorite[] {
  const { kind, minCount = 1, maxLength = Infinity } = options;
  if (kind) {
    const own = mealFavorites(memos.filter((m) => m.meal?.kind === kind), now, limit, { minCount, maxLength });
    if (own.length >= Math.min(3, limit)) return own;
    const rest = mealFavorites(memos, now, limit, { minCount, maxLength }).filter((f) => !own.some((o) => o.item === f.item));
    return [...own, ...rest].slice(0, limit);
  }
  const since = now - 60 * 86_400_000;
  const byItem = new Map<string, MealFavorite & { last: number }>();
  for (const m of memos) {
    if (m.deletedAt || m.archived || !isMealMemo(m)) continue;
    const at = Date.parse(m.meal!.at);
    if (!Number.isFinite(at) || at < since) continue;
    const key = m.meal!.item.trim();
    if (!key || key.length > maxLength) continue;
    const current = byItem.get(key);
    if (!current) byItem.set(key, { item: key, kind: m.meal!.kind, price: m.meal!.price, ...nutritionOf(m.meal!), count: 1, last: at });
    else {
      current.count += 1;
      if (at > current.last) Object.assign(current, { kind: m.meal!.kind, price: m.meal!.price, ...nutritionOf(m.meal!), last: at });
    }
  }
  return [...byItem.values()]
    .filter((f) => f.count >= minCount)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
    .map(({ last: _last, ...rest }) => rest);
}

/** Places used in the last 60 days, most frequent first ('家' always offered). */
export function recentPlaces(memos: Memo[], now = Date.now(), limit = 5): string[] {
  const since = now - 60 * 86_400_000;
  const count = new Map<string, number>();
  for (const m of memos) {
    if (m.deletedAt || m.archived || !isMealMemo(m) || !m.meal!.place) continue;
    if (Date.parse(m.meal!.at) < since) continue;
    count.set(m.meal!.place, (count.get(m.meal!.place) || 0) + 1);
  }
  const list = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return ['家', ...list.filter((p) => p !== '家')].slice(0, limit);
}

export function mealTitle(meal: MealInfo): string {
  const price = meal.price !== null ? ` ¥${meal.price.toLocaleString('ja-JP')}${meal.priceSource === 'estimate' ? '（推定）' : ''}` : '';
  const kcal = meal.kcal ? ` ${meal.kcal.toLocaleString('ja-JP')}kcal` : '';
  const place = meal.place ? ` @${meal.place}` : '';
  const paid = meal.paid !== undefined && meal.paid !== null && meal.paid !== meal.price ? `（支払¥${meal.paid.toLocaleString('ja-JP')}）` : '';
  return `${MEAL_LABEL[meal.kind]}：${meal.item}${price}${paid}${kcal}${place}`;
}

function cleanNumber(value: number | null | undefined, digits = 0): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.max(0, Math.round(value * f) / f);
}

export interface MealInput extends MealNutrition {
  place?: string | null;
  paid?: number | null;
  payment?: MealPayment | null;
  kind: MealKind;
  item: string;
  price: number | null;
  priceSource?: 'receipt' | 'estimate' | null;
  at?: string;
}

function mealBody(meal: MealInfo): string {
  const parts: string[] = [];
  if (meal.kcal) parts.push(`${meal.kcal}kcal`);
  const pfc = [['P', meal.protein], ['F', meal.fat], ['C', meal.carbs]].filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}${v}g`);
  if (pfc.length) parts.push(pfc.join(' '));
  if (meal.price !== null && meal.priceSource) parts.push(meal.priceSource === 'receipt' ? '金額：レシート' : '金額：推定');
  if (meal.payment && meal.payment !== 'self') parts.push(`支払：${PAYMENT_LABEL[meal.payment]}${meal.paid !== undefined && meal.paid !== null ? ` ¥${meal.paid.toLocaleString('ja-JP')}` : ''}`);
  return parts.join(' / ');
}

export async function recordMeal(input: MealInput): Promise<Memo> {
  const item = input.item.trim();
  if (!item) throw new Error('食べたものを入力してください');
  const price = cleanNumber(input.price);
  const meal: MealInfo = { kind: input.kind, item, price, at: input.at || new Date().toISOString() };
  if (price !== null && input.priceSource) meal.priceSource = input.priceSource;
  const kcal = cleanNumber(input.kcal);
  const protein = cleanNumber(input.protein, 1);
  const fat = cleanNumber(input.fat, 1);
  const carbs = cleanNumber(input.carbs, 1);
  if (kcal !== null) meal.kcal = kcal;
  if (protein !== null) meal.protein = protein;
  if (fat !== null) meal.fat = fat;
  if (carbs !== null) meal.carbs = carbs;
  const place = (input.place || '').trim().slice(0, 60);
  if (place) meal.place = place;
  const payment = input.payment && input.payment !== 'self' ? input.payment : null;
  let paid = cleanNumber(input.paid);
  if (payment === 'treated' && paid === null) paid = 0;
  if (payment) meal.payment = payment;
  if (paid !== null && paid !== price) meal.paid = paid;
  return createMemo({ title: mealTitle(meal), body: mealBody(meal), category: MEAL_CATEGORY, meal });
}

/** Record several items in order (e.g. one pasted AI answer). Items a few ms apart keep their order. */
export async function recordMeals(inputs: MealInput[], at = Date.now()): Promise<Memo[]> {
  const saved: Memo[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    saved.push(await recordMeal({ ...inputs[i], at: inputs[i].at || new Date(at + i).toISOString() }));
  }
  return saved;
}

// ---- copy & paste with ChatGPT / Claude ----

/** The question the user pastes into ChatGPT / Claude together with a photo, receipt or a short note. */
export const MEAL_AI_PROMPT = `添付の写真（料理・レシート）やメモの内容を、食事記録アプリ「SASSHY」に貼り付ける形式で書き出してください。

・レシートがあれば、品名と金額はレシートどおりにしてください（金額の根拠＝レシート）。
・レシートがなければ、店名・商品名から一般的な価格を調べて推測してください（金額の根拠＝推測）。分からなければ空欄。
・カロリー（kcal）と栄養（たんぱく質P・脂質F・炭水化物C、単位g）は推定でかまいません。
・1品1行で、次の形式だけをコードブロックで出力してください。説明は不要です。

SASSHY食事
種類|品名|金額|kcal|P|F|C|金額の根拠|場所|支払った額

・金額は食べたものの値段。支払った額は自分が実際に払った額（おごってもらったら0、割り勘なら自分の分、値段と同じなら空欄）。
・場所は食べた・買った場所（家、会社、店名など）。分からなければ空欄。家で作った・家にあったものは金額を空欄にする。
・種類は 朝食／昼食／夕食／間食 のどれか（分からなければ空欄）。
・数字は単位なしの半角数字。

例：
SASSHY食事
昼食|鮭おにぎり|160|180|5|2|38|レシート|ローソン
昼食|唐揚げ 3個|250|300|15|20|12|推測|ローソン`;

const KIND_WORDS: [RegExp, MealKind][] = [
  [/^(朝|朝食|朝ご?はん|breakfast)$/i, 'breakfast'],
  [/^(昼|昼食|ランチ|昼ご?はん|lunch)$/i, 'lunch'],
  [/^(夜|夕|夕食|晩|晩ご?はん|夕ご?はん|夜ご?はん|dinner)$/i, 'dinner'],
  [/^(間食|おやつ|軽食|snack)$/i, 'snack'],
];

function kindOf(word: string): MealKind | null {
  const w = word.trim();
  for (const [re, kind] of KIND_WORDS) if (re.test(w)) return kind;
  return null;
}

/** "約1,280円" → 1280, "150〜180" → 150, "" → null */
function numberOf(text: string | undefined): number | null {
  if (!text) return null;
  const normalized = text.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/,/g, '');
  const match = normalized.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/**
 * Read an answer pasted from ChatGPT / Claude. Accepts code fences, bullets,
 * full-width bars and missing columns. Lines without an item are ignored.
 */
export function parseMealPaste(text: string, fallbackKind: MealKind): MealInput[] {
  const items: MealInput[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/^[-*・]\s*/, '');
    if (!line || line.startsWith('```') || /^SASSHY/i.test(line)) continue;
    if (!/[|｜]/.test(line)) continue;
    line = line.replace(/^[|｜]/, '').replace(/[|｜]$/, '');
    const cols = line.split(/[|｜]/).map((c) => c.trim());
    if (cols.some((c) => c === '品名') || cols.every((c) => /^[-:\s]*$/.test(c))) continue;
    const explicitKind = kindOf(cols[0] || '');
    const kind = explicitKind ?? fallbackKind;
    const rest = explicitKind || cols[0] === '' ? cols.slice(1) : cols;
    const item = (rest[0] || '').trim();
    if (!item) continue;
    const price = numberOf(rest[1]);
    const sourceText = rest[6] || '';
    const place = (rest[7] || '').trim().slice(0, 60);
    const paid = numberOf(rest[8]);
    const priceSource = price === null ? null : /レシート|receipt/i.test(sourceText) ? 'receipt' : 'estimate';
    items.push({
      kind,
      item,
      price,
      priceSource,
      kcal: numberOf(rest[2]),
      protein: numberOf(rest[3]),
      fat: numberOf(rest[4]),
      carbs: numberOf(rest[5]),
      place: place || null,
      ...(paid !== null && paid !== price ? { paid, payment: (paid === 0 ? 'treated' : paid < (price ?? 0) ? 'split' : 'paid_for_others') as MealPayment } : {}),
    });
  }
  return items;
}

export interface MealEdit extends MealNutrition { kind: MealKind; item: string; price: number | null; at: string; place: string | null; payment: MealPayment; paid: number | null }

/** Fix a meal after the fact. Nutrition and unknown AI keys are kept. */
export async function updateMeal(id: string, edit: MealEdit): Promise<Memo | null> {
  const memo = await db.memos.get(id);
  if (!memo?.meal) return null;
  const item = edit.item.trim();
  if (!item) throw new Error('食べたものを入力してください');
  const price = cleanNumber(edit.price);
  const meal: MealInfo = { ...memo.meal, kind: edit.kind, item, price, at: edit.at };
  if (price === null || price !== memo.meal.price) delete meal.priceSource;
  const place = (edit.place || '').trim().slice(0, 60);
  if (place) meal.place = place; else delete meal.place;
  const payment = edit.payment !== 'self' ? edit.payment : null;
  let paid = cleanNumber(edit.paid);
  if (payment === 'treated' && paid === null) paid = 0;
  if (payment) meal.payment = payment; else delete meal.payment;
  if (payment && paid !== null && paid !== price) meal.paid = paid; else delete meal.paid;
  // 栄養は渡されたものだけ書き換える（空欄にしたら消す）。
  for (const [key, digits] of [['kcal', 0], ['protein', 1], ['fat', 1], ['carbs', 1]] as const) {
    if (!(key in edit)) continue;
    const v = cleanNumber(edit[key], digits);
    if (v === null) delete meal[key]; else meal[key] = v;
  }
  return updateMemo(id, { meal, title: mealTitle(meal), body: mealBody(meal) }, '食事の記録を修正');
}

export async function updateExpense(id: string, edit: { item: string; amount: number | null; at: string }): Promise<Memo | null> {
  const memo = await db.memos.get(id);
  if (!memo?.expense) return null;
  const item = edit.item.trim();
  if (!item) throw new Error('何に使ったかを入力してください');
  const amount = cleanNumber(edit.amount);
  if (amount === null) throw new Error('金額を入力してください');
  const expense: ExpenseInfo = { ...memo.expense, item, amount, at: edit.at };
  return updateMemo(id, { expense, title: `支出：${item} ¥${amount.toLocaleString('ja-JP')}` }, '支出の記録を修正');
}

export async function removeMeal(id: string): Promise<void> {
  await updateMemo(id, { deletedAt: new Date().toISOString(), archived: true }, '食事・支出の記録を削除');
}

// ---- lunch reminder setting (device-local, synced like other settings? no: stays on this device) ----
export interface MealReminderSetting { id: 'mealReminder'; enabled: boolean; minute: number }
export const DEFAULT_MEAL_REMINDER: MealReminderSetting = { id: 'mealReminder', enabled: true, minute: 12 * 60 + 45 };

export async function getMealReminder(): Promise<MealReminderSetting> {
  const value = (await db.settings.get('mealReminder')) as unknown as MealReminderSetting | undefined;
  return { ...DEFAULT_MEAL_REMINDER, ...(value || {}) };
}

export async function setMealReminder(changes: Partial<Omit<MealReminderSetting, 'id'>>): Promise<void> {
  const next = { ...(await getMealReminder()), ...changes, id: 'mealReminder' as const };
  await db.settings.put(next as unknown as import('./types').AppSetting);
}

/** Weekday lunch prompts for the next 7 days, skipping days with lunch already recorded. */
export function lunchPrompts(memos: Memo[], setting: MealReminderSetting, now = Date.now(), todayLeft?: number) {
  if (!setting.enabled) return [];
  const prompts: { id: string; fireAt: string; title: string; body: string }[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(now + i * 86_400_000);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(setting.minute / 60), setting.minute % 60).getTime();
    if (at <= now + 2000) continue;
    const key = localDateKey(at);
    if (hasKindOn(memos, key, 'lunch')) continue;
    const money = i === 0 && todayLeft !== undefined ? `今日あと¥${Math.max(0, Math.round(todayLeft)).toLocaleString('ja-JP')}使える・` : '';
    prompts.push({ id: `lunch-${key}`, fireAt: new Date(at).toISOString(), title: 'お昼、なに食べた？', body: `${money}SASSHYで2タップ記録` });
  }
  return prompts;
}
