import { createClient } from 'jsr:@supabase/supabase-js@2';
import { resolveWorkspace } from '../_shared/workspace-auth.ts';
import { parseTaskRequest } from '../sasshy-add-task/validation.ts';
import { parseTaskMutationRequest, parseTaskSearchRequest, type TaskMutationOperation } from '../sasshy-add-task/management.ts';
import { TOOLS, SERVER_INSTRUCTIONS, tokyoDate, addDays } from './tools.ts';
import { applyNutrition, parseMealRequest, parseMealSearchRequest, parseNutritionRequest } from '../sasshy-add-task/meal.ts';

/**
 * SASSHY as a remote MCP server (Streamable HTTP, stateless JSON responses) so
 * Claude and ChatGPT can add / look up / complete tasks directly in a chat.
 * Tasks and meal records (the user approved meals on 2026-10-24). The secret is the last path
 * segment: /functions/v1/sasshy-mcp/<token>; only its SHA-256 is stored.
 */

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, mcp-protocol-version, mcp-session-id, accept',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (message.includes('task was changed')) return '別の端末でタスクが更新されました。list_tasks で最新の revision を取り直してください';
  if (message.includes('task not found')) return 'タスクが見つかりません';
  if (message.includes('cannot mutate deleted')) return '削除済みのタスクです';
  if (message.includes('idempotency key')) return '同じ受付番号が別の内容に使われています';
  return message && error instanceof Error && !('code' in error) ? message : 'SASSHYを更新できませんでした。少し待って再試行してください';
}

// deno-lint-ignore no-explicit-any
async function callTool(client: any, syncKey: string, name: string, args: Record<string, unknown>) {
  if (name === 'add_task') {
    const date = typeof args.date === 'string' && args.date ? args.date : tokyoDate();
    const input = parseTaskRequest({
      idempotency_key: `mcp-${crypto.randomUUID()}`,
      title: args.title,
      notes: args.notes,
      scheduled_date: date === 'none' ? null : date,
      start_time: args.start_time,
      duration_min: args.duration_min ?? 15,
      horizon: date === 'none' ? 'someday' : 'now',
    });
    const { data, error } = await client.rpc('sasshy_v2_ingest_task', { p_sync_key: syncKey, ...input });
    if (error) throw error;
    const t = data?.task;
    return text({ ok: true, task_id: t?.id, title: t?.title, scheduled_date: t?.scheduledDate, duration_min: t?.durationMin, message: 'SASSHYに追加しました' });
  }
  if (name === 'list_tasks') {
    const today = tokyoDate();
    const input = parseTaskSearchRequest({
      query: args.query,
      from_date: args.from_date ?? (args.query ? undefined : today),
      to_date: args.to_date ?? (args.query ? undefined : addDays(today, 6)),
      status: args.status ?? 'open',
      limit: args.limit ?? 30,
    });
    const { data, error } = await client.rpc('sasshy_v2_action_search_tasks', { p_sync_key: syncKey, ...input });
    if (error) throw error;
    return text(data);
  }
  if (name === 'record_meals') {
    const input = parseMealRequest({ idempotency_key: `mcp-${crypto.randomUUID()}`, meals: args.meals });
    const { data, error } = await client.rpc('sasshy_v2_ingest_meals', { p_sync_key: syncKey, p_idempotency_key: input.idempotency_key, p_memos: input.memos });
    if (error) throw error;
    const memos = Array.isArray(data?.memos) ? data.memos : [];
    // deno-lint-ignore no-explicit-any
    const kcal = memos.reduce((sum: number, m: any) => sum + (typeof m.meal?.kcal === 'number' ? m.meal.kcal : 0), 0);
    // deno-lint-ignore no-explicit-any
    return text({ ok: true, count: memos.length, meals: memos.map((m: any) => ({ memo_id: m.id, item: m.meal?.item, kind: m.meal?.kind, kcal: m.meal?.kcal ?? null })), message: `SASSHYに${memos.length}品記録しました${kcal ? `（計${kcal}kcal）` : ''}` });
  }
  if (name === 'list_meals') {
    const input = parseMealSearchRequest({ from_date: args.from_date, to_date: args.to_date, missing_nutrition: args.missing_nutrition ?? false, limit: 50 });
    const { data, error } = await client.rpc('sasshy_v2_action_search_meals', { p_sync_key: syncKey, ...input });
    if (error) throw error;
    return text(data);
  }
  if (name === 'fix_meal_nutrition') {
    const updates = parseNutritionRequest({ updates: args.updates });
    const found = await client.rpc('sasshy_v2_action_search_meals', { p_sync_key: syncKey, p_from_date: null, p_to_date: null, p_missing_nutrition: false, p_limit: 100, p_ids: updates.map((u) => u.memo_id) });
    if (found.error) throw found.error;
    const current = new Map<string, { meal: Record<string, unknown> }>();
    for (const row of (found.data?.meals || []) as { memo_id: string; meal: Record<string, unknown> }[]) current.set(row.memo_id, row);
    // deno-lint-ignore no-explicit-any
    const changes = updates.filter((u) => current.has(u.memo_id)).map((u) => ({ memo_id: u.memo_id, revision: u.revision, ...applyNutrition(current.get(u.memo_id)!.meal as any, u) }));
    if (!changes.length) return text('該当する食事が見つかりませんでした', true);
    const saved = await client.rpc('sasshy_v2_action_set_meal_nutrition', { p_sync_key: syncKey, p_changes: changes });
    if (saved.error) throw saved.error;
    const conflicts = saved.data?.conflicts || [];
    return text({ ok: true, updated: (saved.data?.updated || []).length, conflicts, message: conflicts.length ? '別の端末で更新されていたものがあります。list_meals で取り直してください' : 'カロリー・栄養を直しました' });
  }
  const operations: Record<string, TaskMutationOperation> = { complete_task: 'complete', update_task: 'update', delete_task: 'delete', reopen_task: 'reopen' };
  if (name in operations) {
    const input = parseTaskMutationRequest({ task_id: args.task_id, revision: args.revision, changes: args.changes }, operations[name]);
    const { data, error } = await client.rpc('sasshy_v2_action_mutate_task', { p_sync_key: syncKey, ...input });
    if (error) throw error;
    return text(data);
  }
  return text(`不明なツールです: ${name}`, true);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...cors, Allow: 'POST' } });

  const token = new URL(request.url).pathname.split('/').filter(Boolean).pop() || '';
  const syncKey = Deno.env.get('SASSHY_SYNC_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!syncKey || !supabaseUrl || !serviceRoleKey) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503, headers: { ...headers, ...cors } });
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (token.length < 32) return new Response(null, { status: 404, headers: cors });
  const { data: known } = await client.from('sasshy_mcp_tokens').select('token_hash').eq('token_hash', await sha256Hex(token)).is('revoked_at', null).maybeSingle();
  if (!known) return new Response(null, { status: 404, headers: cors });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 32_768) return new Response(null, { status: 413, headers: cors });
  let parsed: Rpc | Rpc[];
  try { parsed = JSON.parse(raw); } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { status: 400, headers: { ...headers, ...cors } });
  }

  const resolved = await resolveWorkspace(client, syncKey);

  const handle = async (msg: Rpc): Promise<unknown | null> => {
    if (msg.id === undefined || msg.id === null) return null; // notification
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sasshy', title: 'SASSHY', version: '1.0.0' },
          instructions: SERVER_INSTRUCTIONS,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        if (!resolved.workspace) return reply(text('SASSHYの同期先を確認できませんでした', true));
        const name = String(msg.params?.name || '');
        const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
        try {
          return reply(await callTool(client, syncKey, name, args));
        } catch (error) {
          console.error('sasshy mcp tool failed', name);
          return reply(text(errorMessage(error), true));
        }
      }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const replies = (await Promise.all(messages.map(handle))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202, headers: cors });
  const body = Array.isArray(parsed) ? replies : replies[0];
  return new Response(JSON.stringify(body), { status: 200, headers: { ...headers, ...cors } });
});
