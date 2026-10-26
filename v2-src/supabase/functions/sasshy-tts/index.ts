import { createClient } from 'jsr:@supabase/supabase-js@2';
import { resolveWorkspace } from '../_shared/workspace-auth.ts';

/**
 * Natural Japanese voice for the timer lines ("残り5分です" …). The iPhone app
 * asks once per sentence and keeps the sound file, so the same line is free
 * afterwards. Callers: the iPhone app's voice token, or the owner's SASSHY sync
 * key / its SHA-256 (same rule as sasshy-meal-estimate) — that moves with the
 * app's data to a new iPhone, the keychain token does not.
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function same(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

// marin / cedar はChatGPTの音声会話でも使われている、いちばん自然な声。
const VOICES = new Set(['marin', 'cedar', 'coral', 'nova', 'shimmer', 'sage', 'alloy']);
const FALLBACK = 'coral';

async function speak(apiKey: string, voice: string, text: string): Promise<Response> {
  return await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model: Deno.env.get('SASSHY_TTS_MODEL') || 'gpt-4o-mini-tts',
      voice,
      input: text,
      instructions: '日本語を母語とする人の、自然な話し言葉。読み上げ調にせず、そばにいる友だちが話しかけるように、落ち着いてやさしく。語尾は軽く、急かさない。',
      response_format: 'wav',
    }),
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'POSTのみ' });

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 4000) return json(413, { error: '入力が長すぎます' });
    body = JSON.parse(raw);
  } catch { return json(400, { error: '入力を確認してください' }); }

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let allowed = await same(token, Deno.env.get('SASSHY_IOS_VOICE_TOKEN') || '') || await same(token, Deno.env.get('SASSHY_TASK_INGEST_TOKEN') || '');
  const syncKey = typeof body.syncKey === 'string' ? body.syncKey.trim() : '';
  // iPhoneアプリは同期キーそのものではなく、そのSHA-256（Siriの声のタスクと同じ）を送る。
  const credentialHash = typeof body.credentialHash === 'string' && /^[a-f0-9]{64}$/.test(body.credentialHash) ? body.credentialHash : '';
  if (!allowed && (syncKey.length >= 12 || credentialHash)) {
    const client = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', { auth: { persistSession: false, autoRefreshToken: false } });
    // 同期キーは「どんな値でも保存先が作れる」ので、持ち主と同じ保存先かを確かめる。
    const [resolved, owner] = await Promise.all([
      credentialHash ? resolveWorkspace(client, credentialHash, true) : resolveWorkspace(client, syncKey),
      resolveWorkspace(client, Deno.env.get('SASSHY_SYNC_KEY') || ''),
    ]);
    allowed = Boolean(resolved.workspace && owner.workspace && resolved.workspace === owner.workspace);
  }
  if (!allowed) return json(401, { error: '認証できません' });

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 120) return json(400, { error: '1〜120文字で指定してください' });
  const voice = typeof body.voice === 'string' && VOICES.has(body.voice) ? body.voice : 'marin';

  const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
  if (!apiKey) return json(503, { error: 'AIの設定がありません' });
  try {
    let used = voice;
    let response = await speak(apiKey, voice, text);
    // 選んだ声がこのモデルで使えないときは、いつもの声で作る。
    if (!response.ok && voice !== FALLBACK) {
      used = FALLBACK;
      response = await speak(apiKey, FALLBACK, text);
    }
    if (!response.ok) {
      console.error('tts failed', response.status);
      return json(502, { error: '声を作れませんでした' });
    }
    return new Response(response.body, { status: 200, headers: { ...cors, 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Voice-Used': used, 'Access-Control-Expose-Headers': 'X-Voice-Used' } });
  } catch {
    console.error('tts failed');
    return json(502, { error: '声を作れませんでした' });
  }
});
