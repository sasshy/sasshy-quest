// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const workspace = 'a'.repeat(64), otherWorkspace = 'b'.repeat(64);
const credential = 'synthetic-new-credential';
const bearer = 'synthetic-task-bearer';

// Execute the deployed handler source with stubbed network boundaries, not a copy of its auth logic.
function harness(slug: string, denied = false, nativeWorkspace = workspace) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const scopes: string[] = [];
  const from = vi.fn(() => {
    const query: Record<string, unknown> = {};
    for (const method of ['select','eq','order','limit','upsert','update','match','in','is','like']) query[method] = (...args: unknown[]) => {
      if (method === 'eq' && args[0] === 'workspace_hash') scopes.push(String(args[1]));
      return query;
    };
    query.then = (accept: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(accept);
    return query;
  });
  const client = { from, rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name.includes('resolve_')) return denied
      ? { data: null, error: { code: '28000' } }
      : { data: name.includes('voice') ? nativeWorkspace : workspace, error: null };
    if (name === 'sasshy_v2_ingest_voice_task') return { data: { task: { id: 'voice-a', title: 'Synthetic' }, duplicate: true }, error: null };
    return { data: {}, error: null };
  }) };
  const env: Record<string,string> = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service',
    SASSHY_SYNC_KEY: credential, SASSHY_TASK_INGEST_TOKEN: bearer, SASSHY_IOS_VOICE_TOKEN: 'synthetic-voice-token',
    SASSHY_VAPID_PUBLIC_KEY: 'synthetic-public', SASSHY_VAPID_PRIVATE_KEY: 'synthetic-private', SASSHY_PUSH_CRON_SECRET: 'synthetic-cron',
  };
  let handler!: (request: Request) => Promise<Response>;
  const cache = new Map<string, { exports: unknown }>();
  function load(file: string): unknown {
    if (cache.has(file)) return cache.get(file)!.exports;
    const mod = { exports: {} }; cache.set(file,mod);
    const code = ts.transpileModule(readFileSync(file,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    runInNewContext(code, {
      module: mod, exports: mod.exports,
      require: (id: string) => {
        if (id.startsWith('jsr:')) return { createClient: () => client };
        if (id.startsWith('npm:web-push')) return { setVapidDetails: vi.fn(), sendNotification: vi.fn() };
        if (id.startsWith('.')) return load(resolve(dirname(file),id));
        throw new Error('Unexpected handler dependency');
      },
      Deno: { env: { get: (name: string) => env[name] }, serve: (fn: typeof handler) => { handler=fn; } },
      crypto: globalThis.crypto, Request, Response, Headers, TextEncoder, TextDecoder, URL,
      console: { error: vi.fn(), log: vi.fn() },
      fetch: () => { throw new Error('No real network allowed'); },
    });
    return mod.exports;
  }
  load(resolve('supabase/functions',slug,'index.ts'));
  const request = (action: string, body: unknown = {}, token = bearer) => handler(new Request(`https://example.invalid/functions/v1/${slug}/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' }, body: JSON.stringify(body),
  }));
  return { request, calls, scopes, from, client };
}

describe('P3 actual Edge handlers', () => {
  for (const [slug,actions] of [
    ['sasshy-push',['work-start-status','subscribe','unsubscribe','test']],
    ['sasshy-schedule-history',['list','apply']],
    ['sasshy-add-task',['','search','update','complete','reopen','delete','restore','voice']],
  ] as const) {
    for (const action of actions) it(`${slug}/${action} rejects revoked auth before user data access`,async () => {
      const h=harness(slug,true);
      const response=await h.request(action,{ syncKey: credential });
      expect(response.status).toBe(401);
      expect(h.from).not.toHaveBeenCalled();
      expect(h.calls.every(c=>c.name.includes('resolve_'))).toBe(true);
    });
  }
  it('Push status queries the mapped workspace, not the new credential digest',async () => {
    const h=harness('sasshy-push');
    const r=await h.request('work-start-status',{syncKey:credential,taskId:'task-a',dateKey:'2026-09-12'});
    expect(r.status).toBe(200); expect(h.scopes).toContain(workspace);
  });
  it('schedule list queries the mapped workspace',async () => {
    const h=harness('sasshy-schedule-history');
    expect((await h.request('list',{syncKey:credential})).status).toBe(200);
    expect(h.scopes).toEqual([workspace]);
  });
  it('voice accepts a new native fingerprint for the same workspace without losing retry receipts',async () => {
    const h=harness('sasshy-add-task');
    const r=await h.request('voice',{workspace:'c'.repeat(64),idempotency_key:'synthetic-voice-request',transcript:'Synthetic task'});
    expect(r.status).toBe(200);
    expect((await r.json()).duplicate).toBe(true);
    expect(h.calls.some(c=>c.name==='sasshy_v2_resolve_voice_workspace')).toBe(true);
  });
  it('voice rejects a fingerprint from a different workspace before task/AI access',async () => {
    const h=harness('sasshy-add-task',false,otherWorkspace);
    const r=await h.request('voice',{workspace:'c'.repeat(64),idempotency_key:'synthetic-voice-request',transcript:'Synthetic task'});
    expect(r.status).toBe(409);
    expect(h.calls.every(c=>c.name.includes('resolve_'))).toBe(true);
  });
  it('sync credential alone cannot authorize task actions or cron dispatch',async () => {
    const a=harness('sasshy-add-task'), p=harness('sasshy-push');
    expect((await a.request('search',{},credential)).status).toBe(401);
    expect((await p.request('dispatch',{},credential)).status).toBe(401);
    expect(a.calls).toEqual([]); expect(p.calls).toEqual([]);
  });
  it('resolver outage fails closed without private data access',async () => {
    const h=harness('sasshy-schedule-history');
    h.client.rpc.mockRejectedValueOnce(new Error('offline'));
    expect((await h.request('list',{syncKey:credential})).status).toBe(503);
    expect(h.from).not.toHaveBeenCalled();
  });
});
