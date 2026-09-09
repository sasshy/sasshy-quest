import { createClient } from 'jsr:@supabase/supabase-js@2';

type Json = Record<string, unknown>;

const allowedOrigins = new Set([
  'https://sasshy.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(request),
    },
  });
}

function endpoint(request: Request): string {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = parts.lastIndexOf('sasshy-schedule-history');
  return index < 0 ? '' : parts.slice(index + 1).join('/');
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mapHistory(row: Json): Json {
  return {
    id: row.id,
    taskId: row.task_id,
    operationGroupId: row.operation_group_id,
    beforeVersionId: row.before_version_id,
    afterVersionId: row.after_version_id,
    targetVersionId: row.target_version_id,
    operation: row.operation,
    result: row.result,
    before: row.before_schedule,
    after: row.after_schedule,
    title: row.title,
    occurredAt: row.occurred_at,
    serverReceivedAt: row.received_at,
    deviceId: row.device_id,
    source: row.source,
    relatedEntryId: row.related_entry_id,
    reason: row.reason,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return respond(request, 405, { error: '操作が正しくありません' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceRoleKey) return respond(request, 503, { error: '予定履歴サーバーの設定が完了していません' });

  let body: Json;
  try {
    body = await request.json();
  } catch {
    return respond(request, 400, { error: '入力を確認してください' });
  }
  const syncKey = text(body.syncKey, 300);
  if (syncKey.length < 12) return respond(request, 400, { error: '同期キーを確認してください' });
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const action = endpoint(request);

  if (action === 'apply') {
    const operationId = text(body.operationId, 240);
    const taskId = text(body.taskId, 200);
    if (!/^[A-Za-z0-9._:-]+$/.test(operationId) || !/^[A-Za-z0-9._:-]+$/.test(taskId)) {
      return respond(request, 400, { error: '予定履歴の識別子を確認してください' });
    }
    if (!body.task || typeof body.task !== 'object' || !body.history || typeof body.history !== 'object') {
      return respond(request, 400, { error: '予定履歴の内容を確認してください' });
    }
    const { data, error } = await client.rpc('sasshy_v2_apply_schedule_change', {
      p_sync_key: syncKey,
      p_operation_id: operationId,
      p_task_id: taskId,
      p_base_revision: typeof body.baseRevision === 'string' ? body.baseRevision : null,
      p_task: body.task,
      p_update_task: body.updateTask === true,
      p_history: body.history,
    });
    if (error) return respond(request, 500, { error: '予定履歴を保存できませんでした' });
    return respond(request, 200, data);
  }

  if (action === 'list') {
    const workspaceHash = await sha256(syncKey);
    const { data, error } = await client
      .from('sasshy_v2_schedule_history')
      .select('id,task_id,operation_group_id,before_version_id,after_version_id,target_version_id,operation,result,before_schedule,after_schedule,title,occurred_at,received_at,device_id,source,related_entry_id,reason')
      .eq('workspace_hash', workspaceHash)
      .order('occurred_at', { ascending: true })
      .limit(5000);
    if (error) return respond(request, 500, { error: '予定履歴を取得できませんでした' });
    return respond(request, 200, { ok: true, history: (data || []).map((row) => mapHistory(row as Json)) });
  }

  return respond(request, 404, { error: '操作が見つかりません' });
});
