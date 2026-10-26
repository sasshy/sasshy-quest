/** 支出（Claude / ChatGPT から）：入力の確認と、アプリと同じ形のメモにする。 */

const fail = (message: string): never => {
  throw new Error(message);
};

export interface ExpenseMemoDraft {
  title: string;
  category: '支出';
  expense: { item: string; amount: number; at: string; source: 'chatgpt'; category?: string };
}

export function parseExpenses(raw: unknown, now = new Date()): ExpenseMemoDraft[] {
  if (!Array.isArray(raw) || raw.length < 1) fail('expensesに1件以上を指定してください');
  const list = raw as unknown[];
  if (list.length > 20) fail('一度に記録できるのは20件までです');
  return list.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${index + 1}件目の形式を確認してください`);
    const input = value as Record<string, unknown>;
    const item = typeof input.item === 'string' ? input.item.trim() : '';
    if (!item || item.length > 120) fail(`${index + 1}件目の内容（item）は1〜120文字で指定してください`);
    const amount = typeof input.amount === 'number' ? Math.round(input.amount) : NaN;
    if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) fail(`${index + 1}件目の金額（amount）を円の数字で指定してください`);
    let at = now;
    if (input.paid_at !== undefined && input.paid_at !== null && input.paid_at !== '') {
      if (typeof input.paid_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input.paid_at)) fail('paid_atはISO 8601形式で指定してください');
      at = new Date(input.paid_at as string);
      if (Number.isNaN(at.getTime())) fail('paid_atを確認してください');
      if (at.getTime() > now.getTime() + 10 * 60_000 || at.getTime() < now.getTime() - 31 * 86_400_000) fail('paid_atは直近31日以内で指定してください');
    }
    const expense: ExpenseMemoDraft['expense'] = { item, amount, at: at.toISOString(), source: 'chatgpt' };
    if (typeof input.category === 'string' && input.category.trim()) expense.category = input.category.trim().slice(0, 30);
    return { title: `支出：${item} ¥${amount.toLocaleString('ja-JP')}`, category: '支出', expense };
  });
}
