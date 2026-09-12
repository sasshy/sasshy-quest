type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export type WorkspaceResolution = { workspace: string; status: 200 } | { workspace: null; status: 401 | 503 };

/** Fail closed. Never derive an authorization scope locally or log credentials. */
export async function resolveWorkspace(client: RpcClient, credential: string, fingerprint = false): Promise<WorkspaceResolution> {
  try {
    const { data, error } = await client.rpc(
      fingerprint ? 'sasshy_v2_resolve_voice_workspace' : 'sasshy_v2_resolve_workspace',
      fingerprint ? { p_credential_hash: credential } : { p_sync_key: credential },
    );
    if (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      return { workspace: null, status: code === '28000' ? 401 : 503 };
    }
    if (typeof data !== 'string' || !/^[a-f0-9]{64}$/.test(data)) return { workspace: null, status: 503 };
    return { workspace: data, status: 200 };
  } catch { return { workspace: null, status: 503 }; }
}
