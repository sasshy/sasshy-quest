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

  const expectedToken = Deno.env.get('SASSHY_TASK_INGEST_TOKEN') || '';
  const syncKey = Deno.env.get('SASSHY_SYNC_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!expectedToken || !syncKey || !supabaseUrl || !serviceRoleKey) {
    return respond(request, 503, { error: '受付設定が完了していません' });
  }

  const authorization = request.headers.get('Authorization') || '';
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!suppliedToken || !(await tokensMatch(suppliedToken, expectedToken))) {
    return respond(request, 401, { error: '認証できません' });
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 16_384) return respond(request, 413, { error: '入力が大きすぎます' });

  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return respond(request, 400, { error: '入力を確認してください' });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const action = endpoint(request);

  try {
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
