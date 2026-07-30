import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseTaskRequest, type AddTaskRequest } from './validation.ts';

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

  let input;
  try {
    input = parseTaskRequest(await request.json() as AddTaskRequest);
  } catch (error) {
    const message = error instanceof Error ? error.message : '入力を確認してください';
    return respond(request, 400, { error: message });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc('sasshy_v2_ingest_task', {
    p_sync_key: syncKey,
    ...input,
  });

  if (error) {
    console.error('sasshy-add-task failed', error.code || 'unknown');
    return respond(request, 500, { error: 'タスクを保存できませんでした。少し待って再試行してください' });
  }

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
});
