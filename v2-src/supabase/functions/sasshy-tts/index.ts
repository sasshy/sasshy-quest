/**
 * Natural Japanese voice for the timer lines ("残り5分です" …). The iPhone app
 * asks once per sentence and keeps the sound file, so the same line is free
 * afterwards. Only the iPhone app (its voice token) can call this.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

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

const VOICES = new Set(['coral', 'nova', 'shimmer', 'sage', 'alloy']);

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'POSTのみ' });
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const allowed = await same(token, Deno.env.get('SASSHY_IOS_VOICE_TOKEN') || '') || await same(token, Deno.env.get('SASSHY_TASK_INGEST_TOKEN') || '');
  if (!allowed) return json(401, { error: '認証できません' });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json(400, { error: '入力を確認してください' }); }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 120) return json(400, { error: '1〜120文字で指定してください' });
  const voice = typeof body.voice === 'string' && VOICES.has(body.voice) ? body.voice : 'coral';

  const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
  if (!apiKey) return json(503, { error: 'AIの設定がありません' });
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: Deno.env.get('SASSHY_TTS_MODEL') || 'gpt-4o-mini-tts',
        voice,
        input: text,
        instructions: '日本語で、落ち着いたやさしい声。そばで見守る友だちのように、急かさず、はっきり短く話す。',
        response_format: 'wav',
      }),
    });
    if (!response.ok) return json(502, { error: '声を作れませんでした' });
    return new Response(response.body, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
  } catch {
    console.error('tts failed');
    return json(502, { error: '声を作れませんでした' });
  }
});
