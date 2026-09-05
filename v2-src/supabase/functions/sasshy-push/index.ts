import { candidates } from './notifications.ts';
import { workReminderSlot } from '../_shared/work-reminder.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type Json = Record<string, unknown>;

interface StoredRecord {
  workspace_hash: string;
  record_type: 'task' | 'session' | 'memo';
  id: string;
  payload: Json;
}

interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface StoredSubscription {
  workspace_hash: string;
  endpoint_hash: string;
  subscription: WebPushSubscription;
}

interface Candidate {
  workspaceHash: string;
  key: string;
  at: number;
  payload: {
    title: string;
    body: string;
    tag: string;
    kind: string;
    sourceId: string;
    url: string;
  };
}

const allowedOrigins = new Set([
  'https://sasshy.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
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
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  const functionIndex = parts.lastIndexOf('sasshy-push');
  return functionIndex < 0 ? '' : parts.slice(functionIndex + 1).join('/');
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function text(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function validSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const item = value as Json;
  const keys = item.keys as Json | undefined;
  return typeof item.endpoint === 'string'
    && item.endpoint.length <= 2048
    && typeof keys?.p256dh === 'string'
    && typeof keys?.auth === 'string';
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const action = endpoint(request);
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const publicKey = Deno.env.get('SASSHY_VAPID_PUBLIC_KEY') || '';
  const privateKey = Deno.env.get('SASSHY_VAPID_PRIVATE_KEY') || '';
  const subject = Deno.env.get('SASSHY_VAPID_SUBJECT') || 'mailto:sasshy@example.com';
  const cronSecret = Deno.env.get('SASSHY_PUSH_CRON_SECRET') || '';
  if (!supabaseUrl || !serviceRoleKey || !publicKey || !privateKey) {
    return respond(request, 503, { error: '通知サーバーの初期設定が完了していません' });
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (request.method === 'GET' && action === 'config') {
    return respond(request, 200, { publicKey });
  }
  if (request.method !== 'POST') return respond(request, 405, { error: '操作が正しくありません' });

  if (action === 'dispatch') {
    const suppliedSecret = request.headers.get('x-cron-secret') || '';
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if ((!cronSecret || suppliedSecret !== cronSecret) && bearer !== serviceRoleKey) {
      return respond(request, 401, { error: '定期実行を認証できません' });
    }

    const { data: records, error: recordsError } = await client
      .from('sasshy_v2_records')
      .select('workspace_hash,record_type,id,payload')
      .eq('deleted', false);
    if (recordsError) return respond(request, 500, { error: '通知予定を読み込めませんでした' });

    const now = Date.now();
    const due = (records as StoredRecord[])
      .flatMap((record) => candidates(record, now))
      .filter((item) => item.at <= now && (item.payload.kind === 'work' || item.at >= now - 10 * 60_000));
    if (!due.length) return respond(request, 200, { ok: true, due: 0, sent: 0 });

    const workspaces = [...new Set(due.map((item) => item.workspaceHash))];
    const { data: subscriptions, error: subscriptionsError } = await client
      .from('sasshy_v2_push_subscriptions')
      .select('workspace_hash,endpoint_hash,subscription')
      .eq('active', true)
      .in('workspace_hash', workspaces);
    if (subscriptionsError) return respond(request, 500, { error: '通知先を読み込めませんでした' });

    let sent = 0;
    for (const notice of due) {
      for (const subscription of (subscriptions as StoredSubscription[]).filter((item) => item.workspace_hash === notice.workspaceHash)) {
        if (notice.payload.kind === 'work') {
          const { data: latest, error: latestError } = await client.from('sasshy_v2_records')
            .select('payload,deleted').match({ workspace_hash: notice.workspaceHash, record_type: 'task', id: notice.payload.sourceId }).maybeSingle();
          if (latestError || !latest || latest.deleted || workReminderSlot(latest.payload, now) !== notice.at) continue;
        }
        const delivery = {
          workspace_hash: notice.workspaceHash,
          notification_key: notice.key,
          endpoint_hash: subscription.endpoint_hash,
        };
        const { error: claimError } = await client.from('sasshy_v2_push_deliveries').insert(delivery);
        if (claimError) continue;
        try {
          await webpush.sendNotification(subscription.subscription, JSON.stringify(notice.payload), {
            TTL: 60 * 60,
            urgency: notice.payload.kind === 'timer' ? 'high' : 'normal',
          });
          sent += 1;
          await client.from('sasshy_v2_push_deliveries')
            .update({ delivered_at: new Date().toISOString(), error: '' })
            .match(delivery);
        } catch (error) {
          const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
          await client.from('sasshy_v2_push_deliveries')
            .update({ error: text(error instanceof Error ? error.message : String(error), 500) })
            .match(delivery);
          if (statusCode === 404 || statusCode === 410) {
            await client.from('sasshy_v2_push_subscriptions')
              .update({ active: false, updated_at: new Date().toISOString() })
              .match({ workspace_hash: notice.workspaceHash, endpoint_hash: subscription.endpoint_hash });
          }
        }
      }
    }
    return respond(request, 200, { ok: true, due: due.length, sent });
  }

  let body: Json;
  try {
    body = await request.json();
  } catch {
    return respond(request, 400, { error: '入力を確認してください' });
  }
  const syncKey = text(body.syncKey, 300);
  if (syncKey.length < 12) return respond(request, 400, { error: '同期キーを確認してください' });
  const workspaceHash = await sha256(syncKey);

  if (action === 'subscribe') {
    if (!validSubscription(body.subscription)) return respond(request, 400, { error: '通知の購読情報が正しくありません' });
    const endpointHash = await sha256(body.subscription.endpoint);
    const { error } = await client.from('sasshy_v2_push_subscriptions').upsert({
      workspace_hash: workspaceHash,
      endpoint_hash: endpointHash,
      subscription: body.subscription,
      device_name: text(body.deviceName, 80),
      active: true,
      updated_at: new Date().toISOString(),
    });
    if (error) return respond(request, 500, { error: '通知先を保存できませんでした。通知用SQLを実行してください' });
    return respond(request, 200, { ok: true, message: 'この端末を通知先に登録しました' });
  }

  if (action === 'unsubscribe') {
    const endpointValue = text(body.endpoint, 2048);
    if (endpointValue) {
      const endpointHash = await sha256(endpointValue);
      await client.from('sasshy_v2_push_subscriptions')
        .update({ active: false, updated_at: new Date().toISOString() })
        .match({ workspace_hash: workspaceHash, endpoint_hash: endpointHash });
    }
    return respond(request, 200, { ok: true });
  }

  if (action === 'test') {
    const endpointValue = text(body.endpoint, 2048);
    const query = client.from('sasshy_v2_push_subscriptions')
      .select('workspace_hash,endpoint_hash,subscription')
      .eq('workspace_hash', workspaceHash)
      .eq('active', true);
    if (endpointValue) query.eq('endpoint_hash', await sha256(endpointValue));
    const { data, error } = await query;
    if (error || !data?.length) return respond(request, 404, { error: 'この端末の通知登録が見つかりません' });
    try {
      for (const subscription of data as StoredSubscription[]) {
        await webpush.sendNotification(subscription.subscription, JSON.stringify({
          title: 'SASSHY通知テスト',
          body: 'バックグラウンド通知を受け取れる状態です',
          tag: `sasshy-test-${Date.now()}`,
          kind: 'test',
          url: './?open=settings',
        }), { TTL: 300, urgency: 'high' });
      }
      return respond(request, 200, { ok: true, message: 'テスト通知を送信しました' });
    } catch {
      return respond(request, 502, { error: '通知サービスへの送信に失敗しました。通知を一度停止して再登録してください' });
    }
  }

  return respond(request, 404, { error: '通知操作が見つかりません' });
});
