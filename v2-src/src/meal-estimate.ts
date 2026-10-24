import { getSyncConfig } from './sync';

/** Calories / PFC estimated by AI (server function; about 0.1円 per call). Nothing is saved here. */
export interface MealEstimate { item: string; kcal: number; protein: number; fat: number; carbs: number }

export async function estimateMeal(text: string, mode: 'single' | 'menu'): Promise<{ items: MealEstimate[]; note: string }> {
  const config = await getSyncConfig();
  if (!config.url || !config.apiKey || !config.syncKey) throw new Error('同期設定が必要です（設定 › 同期）');
  const key = config.apiKey.trim();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${config.url.trim().replace(/\/+$/, '')}/functions/v1/sasshy-meal-estimate`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncKey: config.syncKey, text, mode }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as { items?: MealEstimate[]; note?: string; error?: string };
    if (!response.ok || !payload.items?.length) throw new Error(payload.error || 'AIに計算してもらえませんでした');
    return { items: payload.items, note: payload.note || '' };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('時間がかかりすぎました。もう一度押してください');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
