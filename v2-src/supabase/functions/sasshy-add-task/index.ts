import { parseVoiceInput, extractVoiceTask } from './voice.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseTaskRequest, type AddTaskRequest } from './validation.ts';
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

  try {
    if (action === 'voice') {
      const input = parseVoiceInput(body);
      const workspace = (body as Record<string, unknown>).workspace;
      if (workspace !== undefined) {
        const digest = Array.from(await tokenDigest(syncKey)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (typeof workspace !== 'string' || !(await tokensMatch(workspace, digest))) return respond(request, 409, { error: 'iPhoneの同期先と受付キーの保存先が一致しません。設定を確認してください' });
      }
      // Check before AI: a retry does not pay for extraction again or change relative dates.
      const args = { p_sync_key: syncKey, p_idempotency_key: input.idempotency_key, p_transcript: input.transcript };
      const existing = await client.rpc('sasshy_v2_ingest_voice_task', { ...args, p_task: null });
      if (existing.error) throw existing.error;
      let result = existing.data;
      if (!result) {
        const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
        if (!apiKey) return respond(request, 503, { error: '音声整理用のAIキーが未設定です。タスクは未登録です' });
        const task = await extractVoiceTask(input.transcript, apiKey, Deno.env.get('SASSHY_VOICE_MODEL') || 'gpt-4.1-mini-2025-04-14');
        const saved = await client.rpc('sasshy_v2_ingest_voice_task', { ...args, p_task: task });
        if (saved.error) throw saved.error;
        result = saved.data;
      }
      if (!result?.task?.id) throw new Error('保存を確認できませんでした。同じ受付番号で再試行してください');
      return respond(request, 200, { ok: true, task_id: result.task.id, task: result.task, duplicate: Boolean(result.duplicate),
        message: `${result.duplicate ? '登録済みです' : 'SASSHYに追加しました'}：${result.task.title}。期限：${result.task.dueDate || '未指定'} ${result.task.dueTime || ''}。相手：${result.task.counterparty || '未指定'}。依頼元：${result.task.requestSource || '未指定'}` });
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
