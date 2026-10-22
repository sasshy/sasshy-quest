/**
 * ChatGPT action: record meals/snacks as SASSHY memos (category '食事' + meal).
 * The payload shape and title/body text match v2-src/src/meals.ts so records
 * created here look the same as ones recorded in the app.
 */
export type MealKind = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface MealActionRequest {
  idempotency_key?: unknown;
  meals?: unknown;
}

export interface MealMemoDraft {
  title: string;
  body: string;
  category: '食事';
  pinned: false;
  reminderAt: null;
  archived: false;
  meal: {
    kind: MealKind;
    item: string;
    price: number | null;
    at: string;
    priceSource?: 'receipt' | 'estimate';
    kcal?: number;
    protein?: number;
    fat?: number;
    carbs?: number;
    place?: string;
    paid?: number;
    payment?: MealPayment;
  };
}

export type MealPayment = 'treated' | 'split' | 'paid_for_others';
const PAYMENT_LABEL: Record<MealPayment, string> = { treated: 'おごってもらった', split: '割り勘', paid_for_others: '自分がおごった' };

const KINDS: MealKind[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const LABEL: Record<MealKind, string> = { breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: '間食' };
const MAX_ITEMS = 20;

function fail(message: string): never {
  throw new Error(message);
}

/** Same rule as the app's suggestKind, evaluated in Asia/Tokyo. */
export function kindForTime(at: Date): MealKind {
  const jst = new Date(at.getTime() + 9 * 3_600_000);
  const h = jst.getUTCHours() + jst.getUTCMinutes() / 60;
  if (h >= 4 && h < 10) return 'breakfast';
  if (h >= 10.5 && h < 14.5) return 'lunch';
  if (h >= 17.5 && h < 22) return 'dinner';
  return 'snack';
}

function optionalNumber(value: unknown, name: string, max: number, digits: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(`${name}は0〜${max}の数値で指定してください`);
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function mealTitle(meal: MealMemoDraft['meal']): string {
  const price = meal.price !== null ? ` ¥${meal.price.toLocaleString('ja-JP')}${meal.priceSource === 'estimate' ? '（推定）' : ''}` : '';
  const kcal = meal.kcal ? ` ${meal.kcal.toLocaleString('ja-JP')}kcal` : '';
  const place = meal.place ? ` @${meal.place}` : '';
  const paid = meal.paid !== undefined && meal.paid !== meal.price ? `（支払¥${meal.paid.toLocaleString('ja-JP')}）` : '';
  return `${LABEL[meal.kind]}：${meal.item}${price}${paid}${kcal}${place}`;
}

export function mealBody(meal: MealMemoDraft['meal']): string {
  const parts: string[] = [];
  if (meal.kcal) parts.push(`${meal.kcal}kcal`);
  const pfc = ([['P', meal.protein], ['F', meal.fat], ['C', meal.carbs]] as const)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}${v}g`);
  if (pfc.length) parts.push(pfc.join(' '));
  if (meal.price !== null && meal.priceSource) parts.push(meal.priceSource === 'receipt' ? '金額：レシート' : '金額：推定');
  if (meal.payment) parts.push(`支払：${PAYMENT_LABEL[meal.payment]}${meal.paid !== undefined ? ` ¥${meal.paid.toLocaleString('ja-JP')}` : ''}`);
  return parts.join(' / ');
}

export function parseMealRequest(body: MealActionRequest, now = new Date()): { idempotency_key: string; memos: MealMemoDraft[] } {
  const key = body.idempotency_key;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(key)) fail('idempotency_keyを確認してください');
  if (!Array.isArray(body.meals) || body.meals.length < 1) fail('mealsに1品以上を指定してください');
  if (body.meals.length > MAX_ITEMS) fail(`一度に記録できるのは${MAX_ITEMS}品までです`);

  const memos = body.meals.map((raw, index): MealMemoDraft => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${index + 1}品目の形式を確認してください`);
    const input = raw as Record<string, unknown>;
    const item = typeof input.item === 'string' ? input.item.trim() : '';
    if (!item || item.length > 120) fail(`${index + 1}品目の品名（item）は1〜120文字で指定してください`);

    let at = now;
    if (input.eaten_at !== undefined && input.eaten_at !== null && input.eaten_at !== '') {
      if (typeof input.eaten_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input.eaten_at)) fail('eaten_atはISO 8601形式で指定してください');
      at = new Date(input.eaten_at);
      if (Number.isNaN(at.getTime())) fail('eaten_atを確認してください');
      if (at.getTime() > now.getTime() + 10 * 60_000 || at.getTime() < now.getTime() - 14 * 86_400_000) fail('eaten_atは直近14日以内で指定してください');
    }

    let kind: MealKind;
    if (input.kind === undefined || input.kind === null || input.kind === '') kind = kindForTime(at);
    else if (typeof input.kind === 'string' && (KINDS as string[]).includes(input.kind)) kind = input.kind as MealKind;
    else fail('kindは breakfast / lunch / dinner / snack のいずれかです');

    const price = optionalNumber(input.price, 'price', 1_000_000, 0);
    let priceSource: 'receipt' | 'estimate' | undefined;
    if (price !== null) {
      if (input.price_source === undefined || input.price_source === null || input.price_source === 'estimate') priceSource = 'estimate';
      else if (input.price_source === 'receipt') priceSource = 'receipt';
      else fail('price_sourceは receipt / estimate のいずれかです');
    }

    const meal: MealMemoDraft['meal'] = { kind, item, price, at: at.toISOString() };
    if (priceSource) meal.priceSource = priceSource;
    const kcal = optionalNumber(input.kcal, 'kcal', 10_000, 0);
    const protein = optionalNumber(input.protein, 'protein', 1_000, 1);
    const fat = optionalNumber(input.fat, 'fat', 1_000, 1);
    const carbs = optionalNumber(input.carbs, 'carbs', 1_000, 1);
    if (kcal !== null) meal.kcal = kcal;
    if (protein !== null) meal.protein = protein;
    if (fat !== null) meal.fat = fat;
    if (carbs !== null) meal.carbs = carbs;
    if (input.place !== undefined && input.place !== null && input.place !== '') {
      if (typeof input.place !== 'string' || input.place.trim().length > 60) fail('placeは60文字以内で指定してください');
      if (input.place.trim()) meal.place = input.place.trim();
    }
    let payment: MealPayment | null = null;
    if (input.payment !== undefined && input.payment !== null && input.payment !== '' && input.payment !== 'self') {
      if (input.payment !== 'treated' && input.payment !== 'split' && input.payment !== 'paid_for_others') fail('paymentは self / treated / split / paid_for_others のいずれかです');
      payment = input.payment;
    }
    let paid = optionalNumber(input.paid, 'paid', 1_000_000, 0);
    if (payment === 'treated' && paid === null) paid = 0;
    if (payment) meal.payment = payment;
    if (paid !== null && paid !== price) meal.paid = paid;

    return { title: mealTitle(meal), body: mealBody(meal), category: '食事', pinned: false, reminderAt: null, archived: false, meal };
  });

  return { idempotency_key: key, memos };
}

// ---- search meals / fill in nutrition later ----

export interface MealSearchRequest { from_date?: unknown; to_date?: unknown; missing_nutrition?: unknown; limit?: unknown }
export interface ParsedMealSearch { p_from_date: string; p_to_date: string; p_missing_nutrition: boolean; p_limit: number; p_ids: null }

function tokyoDate(at: Date): string {
  return new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

function dateParam(value: unknown, name: string, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${name}はYYYY-MM-DD形式で指定してください`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail(`${name}が存在しない日付です`);
  return value;
}

/** Defaults: the last 7 days (Asia/Tokyo), only meals without kcal. */
export function parseMealSearchRequest(body: MealSearchRequest, now = new Date()): ParsedMealSearch {
  const to = dateParam(body.to_date, 'to_date', tokyoDate(now));
  const from = dateParam(body.from_date, 'from_date', tokyoDate(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000)));
  if (from > to) fail('from_dateはto_date以前にしてください');
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 92 * 86_400_000) fail('期間は93日以内にしてください');
  let missing = true;
  if (body.missing_nutrition !== undefined && body.missing_nutrition !== null) {
    if (typeof body.missing_nutrition !== 'boolean') fail('missing_nutritionはtrueかfalseです');
    missing = body.missing_nutrition;
  }
  let limit = 50;
  if (body.limit !== undefined && body.limit !== null) {
    if (!Number.isInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 100) fail('limitは1〜100の整数です');
    limit = body.limit as number;
  }
  return { p_from_date: from, p_to_date: to, p_missing_nutrition: missing, p_limit: limit, p_ids: null };
}

export interface NutritionUpdateInput { memo_id: string; revision: string; kcal: number | null; protein: number | null; fat: number | null; carbs: number | null }

export function parseNutritionRequest(body: { updates?: unknown }): NutritionUpdateInput[] {
  if (!Array.isArray(body.updates) || body.updates.length < 1) fail('updatesに1件以上を指定してください');
  if (body.updates.length > 50) fail('一度に更新できるのは50件までです');
  const seen = new Set<string>();
  return body.updates.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${index + 1}件目の形式を確認してください`);
    const u = raw as Record<string, unknown>;
    if (typeof u.memo_id !== 'string' || !/^memo-[A-Za-z0-9._:-]{1,190}$/.test(u.memo_id)) fail(`${index + 1}件目のmemo_idを確認してください`);
    if (seen.has(u.memo_id)) fail('同じmemo_idが重複しています');
    seen.add(u.memo_id);
    if (typeof u.revision !== 'string' || Number.isNaN(Date.parse(u.revision))) fail(`${index + 1}件目のrevisionを確認してください`);
    const item = {
      memo_id: u.memo_id,
      revision: u.revision,
      kcal: optionalNumber(u.kcal, 'kcal', 10_000, 0),
      protein: optionalNumber(u.protein, 'protein', 1_000, 1),
      fat: optionalNumber(u.fat, 'fat', 1_000, 1),
      carbs: optionalNumber(u.carbs, 'carbs', 1_000, 1),
    };
    if (item.kcal === null && item.protein === null && item.fat === null && item.carbs === null) fail(`${index + 1}件目に kcal / protein / fat / carbs のどれかを指定してください`);
    return item;
  });
}

/** Current stored meal + new nutrition → the full memo fields to write (item, price etc. never change). */
export function applyNutrition(current: MealMemoDraft['meal'], update: NutritionUpdateInput): { meal: MealMemoDraft['meal']; title: string; body: string } {
  const meal: MealMemoDraft['meal'] = { ...current };
  if (update.kcal !== null) meal.kcal = update.kcal;
  if (update.protein !== null) meal.protein = update.protein;
  if (update.fat !== null) meal.fat = update.fat;
  if (update.carbs !== null) meal.carbs = update.carbs;
  return { meal, title: mealTitle(meal), body: mealBody(meal) };
}
