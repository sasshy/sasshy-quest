import { resolveWorkspace } from '../_shared/workspace-auth.ts';
import { parseVoiceInput, extractVoiceTask, fallbackVoiceTask, placeVoiceTask } from './voice.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseTaskRequest, type AddTaskRequest } from './validation.ts';
import {
  applyNutrition,
  parseMealRequest,
  parseMealSearchRequest,
  parseNutritionRequest,
  type MealActionRequest,
  type MealSearchRequest,
} from './meal.ts';
import {
  parseTaskMutationRequest,
  parseTaskSearchRequest,
  type TaskMutationOperation,
  type TaskMutationRequest,
  type TaskSearchRequest,
} from './management.ts';

const allowedOrigins = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders(request) },
  });
}

function endpoint(request: Request): string {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const functionIndex = parts.lastIndexOf('sasshy-add-task');
  return functionIndex < 0 ? '' : parts.slice(functionIndex + 1).join('/');
}

async function tokenDigest(value: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function tokensMatch(actual: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([tokenDigest(actual), tokenDigest(expected)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') return respond(request, 405, { error: 'POSTのみ利用できます' });

  const action = endpoint(request);
  const expectedToken = Deno.env.get('SASSHY_TASK_INGEST_TOKEN') || '';
  const iosVoiceToken = action === 'voice' ? Deno.env.get('SASSHY_IOS_VOICE_TOKEN') || '' : '';
  const syncKey = Deno.env.get('SASSHY_SYNC_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!expectedToken || !syncKey || !supabaseUrl || !serviceRoleKey) {
    return respond(request, 503, { error: '受付設定が完了していません' });
  }

  const authorization = request.headers.get('Authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const accepted = suppliedToken && (
    await tokensMatch(suppliedToken, expectedToken)
    || Boolean(iosVoiceToken) && await tokensMatch(suppliedToken, iosVoiceToken)
  );
  if (!accepted) {
    return respond(request, 401, { error: '認証できません' });
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 16_384) return respond(request, 413, { error: '入力が大きすぎます' });

  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 16_384) return respond(request, 413, { error: '入力が大きすぎます' });
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(request, 400, { error: '入力を確認してください' });
  } catch (error) {
    return respond(request, 400, { error: '入力を確認してください' });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const resolved = await resolveWorkspace(client, syncKey);
  if (!resolved.workspace) return respond(request, resolved.status, { error: '受付の同期先を認証できません' });

  try {
    if (action === 'voice') {
      const input = parseVoiceInput(body);
      const workspace = (body as Record<string, unknown>).workspace;
      if (workspace !== undefined) {
        if (typeof workspace !== 'string' || !/^[a-f0-9]{64}$/.test(workspace)) return respond(request, 409, { error: 'iPhoneの同期先を確認してください' });
        const native = await resolveWorkspace(client, workspace, true);
        if (!native.workspace) return respond(request, native.status, { error: 'iPhoneの同期先を認証できません' });
        if (!(await tokensMatch(native.workspace, resolved.workspace))) return respond(request, 409, { error: 'iPhoneの同期先と受付キーの保存先が一致しません。設定を確認してください' });
      }
      // Check before AI: a retry does not pay for extraction again or change relative dates.
      const args = { p_sync_key: syncKey, p_idempotency_key: input.idempotency_key, p_transcript: input.transcript };
      const existing = await client.rpc('sasshy_v2_ingest_voice_task', { ...args, p_task: null });
      if (existing.error) throw existing.error;
      let result = existing.data;
      if (!result) {
        // Capture first: if the AI is missing or can't organise it, keep what was said.
        const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
        let task = fallbackVoiceTask(input.transcript);
        if (apiKey) {
          try {
            task = await extractVoiceTask(input.transcript, apiKey, Deno.env.get('SASSHY_VOICE_MODEL') || 'gpt-4.1-mini-2025-04-14');
          } catch {
            console.error('voice extraction failed; saved as spoken');
          }
        }
        task = placeVoiceTask(task);
        const saved = await client.rpc('sasshy_v2_ingest_voice_task', { ...args, p_task: task });
        if (saved.error) throw saved.error;
        result = saved.data;
      }
      if (!result?.task?.id) throw new Error('保存を確認できませんでした。同じ受付番号で再試行してください');
      return respond(request, 200, { ok: true, task_id: result.task.id, task: result.task, duplicate: Boolean(result.duplicate),
        message: `${result.duplicate ? '登録済みです' : result.task.dueDate ? `${result.task.dueDate}の予定に追加しました` : '今日のリストに追加しました'}：${result.task.title}` });
    }

    if (action === 'meal') {
      const input = parseMealRequest(body as MealActionRequest);
      const { data, error } = await client.rpc('sasshy_v2_ingest_meals', {
        p_sync_key: syncKey,
        p_idempotency_key: input.idempotency_key,
        p_memos: input.memos,
      });
      if (error) throw error;
      const memos = Array.isArray(data?.memos) ? data.memos : [];
      const meals = memos.map((memo: { id?: string; title?: string; meal?: Record<string, unknown> }) => ({
        memo_id: memo.id,
        title: memo.title,
        kind: memo.meal?.kind,
        item: memo.meal?.item,
        price: memo.meal?.price ?? null,
        kcal: memo.meal?.kcal ?? null,
      }));
      const spend = meals.reduce((sum: number, m: { price: unknown }) => sum + (typeof m.price === 'number' ? m.price : 0), 0);
      const kcal = meals.reduce((sum: number, m: { kcal: unknown }) => sum + (typeof m.kcal === 'number' ? m.kcal : 0), 0);
      return respond(request, 200, {
        ok: true,
        duplicate: Boolean(data?.duplicate),
        count: meals.length,
        meals,
        message: `${data?.duplicate ? '記録済みです' : 'SASSHYに食事を記録しました'}：${meals.length}品${spend ? ` ¥${spend.toLocaleString('ja-JP')}` : ''}${kcal ? ` ${kcal.toLocaleString('ja-JP')}kcal` : ''}`,
      });
    }

    if (action === 'meals/search') {
      const input = parseMealSearchRequest(body as MealSearchRequest);
      const { data, error } = await client.rpc('sasshy_v2_action_search_meals', { p_sync_key: syncKey, ...input });
      if (error) throw error;
      return respond(request, 200, data);
    }

    if (action === 'meals/nutrition') {
      const updates = parseNutritionRequest(body as { updates?: unknown });
      const found = await client.rpc('sasshy_v2_action_search_meals', {
        p_sync_key: syncKey,
        p_from_date: null,
        p_to_date: null,
        p_missing_nutrition: false,
        p_limit: 100,
        p_ids: updates.map((u) => u.memo_id),
      });
      if (found.error) throw found.error;
      const current = new Map<string, { revision: string; meal: Record<string, unknown> }>();
      for (const row of (found.data?.meals || []) as { memo_id: string; revision: string; meal: Record<string, unknown> }[]) current.set(row.memo_id, row);
      const missing: string[] = [];
      const changes = [];
      for (const update of updates) {
        const row = current.get(update.memo_id);
        if (!row) { missing.push(update.memo_id); continue; }
        // deno-lint-ignore no-explicit-any
        const next = applyNutrition(row.meal as any, update);
        changes.push({ memo_id: update.memo_id, revision: update.revision, ...next });
      }
      let result = { updated: [] as unknown[], conflicts: [] as string[] };
      if (changes.length) {
        const saved = await client.rpc('sasshy_v2_action_set_meal_nutrition', { p_sync_key: syncKey, p_changes: changes });
        if (saved.error) throw saved.error;
        result = { updated: saved.data?.updated || [], conflicts: saved.data?.conflicts || [] };
      }
      const n = result.updated.length;
      return respond(request, 200, {
        ok: true,
        updated: result.updated,
        conflicts: result.conflicts,
        not_found: missing,
        message: `${n}件のカロリー・栄養を記録しました${result.conflicts.length ? `。${result.conflicts.length}件は別の端末で更新されていたため未反映（再検索してください）` : ''}${missing.length ? `。${missing.length}件は見つかりませんでした` : ''}`,
      });
    }

    if (action === 'search') {
      const input = parseTaskSearchRequest(body as TaskSearchRequest);
      const { data, error } = await client.rpc('sasshy_v2_action_search_tasks', {
        p_sync_key: syncKey,
        ...input,
      });
      if (error) throw error;
      return respond(request, 200, data);
    }

    const mutationByEndpoint: Record<string, TaskMutationOperation> = {
      update: 'update',
      complete: 'complete',
      reopen: 'reopen',
      delete: 'delete',
      restore: 'restore',
    };
    if (action in mutationByEndpoint) {
      const input = parseTaskMutationRequest(
        body as TaskMutationRequest,
        mutationByEndpoint[action],
      );
      const { data, error } = await client.rpc('sasshy_v2_action_mutate_task', {
        p_sync_key: syncKey,
        ...input,
      });
      if (error) throw error;
      return respond(request, 200, data);
    }

    if (action) return respond(request, 404, { error: '操作が見つかりません' });

    const input = parseTaskRequest(body as AddTaskRequest);
    const { data, error } = await client.rpc('sasshy_v2_ingest_task', {
      p_sync_key: syncKey,
      ...input,
    });
    if (error) throw error;

    const task = data?.task;
    return respond(request, 200, {
      ok: true,
      task_id: task?.id,
      title: task?.title,
      scheduled_date: task?.scheduledDate,
      start_minute: task?.startMinute,
      duration_min: task?.durationMin,
      duplicate: Boolean(data?.duplicate),
      message: data?.duplicate ? 'すでに同じ依頼を登録済みです' : 'SASSHYへ追加しました',
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : '';
    console.error('sasshy task action failed');
    if (error && typeof error === 'object' && 'code' in error && error.code === '28000') return respond(request, 401, { error: '受付の同期先を認証できません' });
    if (message.includes('idempotency key')) return respond(request, 409, { error: '同じ受付番号が別の内容に使われています。新しい受付番号で送信してください' });
    if (message.includes('task was changed')) {
      return respond(request, 409, {
        error: '別の端末でタスクが更新されました。もう一度検索して最新内容を確認してください',
      });
    }
    if (message.includes('task not found')) {
      return respond(request, 404, { error: 'タスクが見つかりません' });
    }
    if (message.includes('cannot restore')) {
      return respond(request, 400, { error: 'このタスクは削除されていません' });
    }
    if (message.includes('cannot mutate deleted')) {
      return respond(request, 400, { error: '削除済みタスクです。先に復元してください' });
    }
    if (error instanceof Error && !('code' in error)) {
      return respond(request, 400, { error: message || '入力を確認してください' });
    }
    return respond(request, 500, {
      error: 'SASSHYを更新できませんでした。少し待って再試行してください',
    });
  }
});
