-- SASSHY MCP connector (Claude / ChatGPT): the secret in the connector URL.
-- Only the SHA-256 is stored; the Edge Function compares hashes with the service role.
create table if not exists public.sasshy_mcp_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.sasshy_mcp_tokens enable row level security;
revoke all on public.sasshy_mcp_tokens from anon, authenticated;
