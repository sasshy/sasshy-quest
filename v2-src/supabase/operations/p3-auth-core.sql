-- P3: credential hashes are distinct from permanent workspace identifiers.
-- No credential or workspace is migrated by installing this schema.
create schema if not exists sasshy_private;
revoke all on schema sasshy_private from public, anon, authenticated;
grant usage on schema sasshy_private to anon, authenticated, service_role;

create table if not exists sasshy_private.workspace_credentials (
  credential_hash text primary key check (credential_hash ~ '^[a-f0-9]{64}$'),
  workspace_hash text not null check (workspace_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (credential_hash <> workspace_hash)
);
create index if not exists workspace_credentials_workspace_idx
  on sasshy_private.workspace_credentials(workspace_hash);
create table if not exists sasshy_private.workspace_auth (
  workspace_hash text primary key check (workspace_hash ~ '^[a-f0-9]{64}$'),
  legacy_disabled_at timestamptz not null default now()
);
alter table sasshy_private.workspace_credentials enable row level security;
alter table sasshy_private.workspace_auth enable row level security;
revoke all on sasshy_private.workspace_credentials, sasshy_private.workspace_auth
  from public, anon, authenticated, service_role;

create or replace function sasshy_private.resolve_hash(p_hash text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_row sasshy_private.workspace_credentials%rowtype;
begin
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='28000', message='invalid credential';
  end if;
  select * into v_row from sasshy_private.workspace_credentials where credential_hash=p_hash;
  if found then
    if v_row.revoked_at is not null then
      raise exception using errcode='28000', message='invalid credential';
    end if;
    return v_row.workspace_hash;
  end if;
  if exists(select 1 from sasshy_private.workspace_auth where workspace_hash=p_hash) then
    raise exception using errcode='28000', message='invalid credential';
  end if;
  -- Only workspaces outside the explicitly migrated set retain legacy behavior.
  return p_hash;
end;
$$;
revoke all on function sasshy_private.resolve_hash(text) from public, anon, authenticated;
grant execute on function sasshy_private.resolve_hash(text) to service_role;

create or replace function sasshy_private.resolve_credential(p_sync_key text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if p_sync_key is null or length(p_sync_key) not between 12 and 300 then
    raise exception using errcode='28000', message='invalid credential';
  end if;
  return sasshy_private.resolve_hash(encode(extensions.digest(p_sync_key, 'sha256'),'hex'));
end;
$$;
revoke all on function sasshy_private.resolve_credential(text) from public, anon, authenticated;
grant execute on function sasshy_private.resolve_credential(text) to anon, authenticated, service_role;

-- Edge Functions use a service-role-only API. A workspace hash is NOT a client credential.
create or replace function public.sasshy_v2_resolve_workspace(p_sync_key text)
returns text language sql stable security invoker set search_path = '' as $$
  select sasshy_private.resolve_credential(p_sync_key);
$$;
revoke all on function public.sasshy_v2_resolve_workspace(text) from public, anon, authenticated;
grant execute on function public.sasshy_v2_resolve_workspace(text) to service_role;

-- Native voice sends a credential fingerprint after its separate Bearer check.
create or replace function public.sasshy_v2_resolve_voice_workspace(p_credential_hash text)
returns text language sql stable security invoker set search_path = '' as $$
  select sasshy_private.resolve_hash(p_credential_hash);
$$;
revoke all on function public.sasshy_v2_resolve_voice_workspace(text) from public, anon, authenticated;
grant execute on function public.sasshy_v2_resolve_voice_workspace(text) to service_role;

-- Read-only preflight for a client's credential change. No rows or credential hashes returned.
create or replace function public.sasshy_v2_connection_info(p_sync_key text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('workspaceId',sasshy_private.resolve_credential(p_sync_key));
$$;
revoke all on function public.sasshy_v2_connection_info(text) from public;
grant execute on function public.sasshy_v2_connection_info(text) to anon, authenticated, service_role;

-- Admin-only operations take a SHA-256 digest, never a raw credential.
create or replace function sasshy_private.stage_credential(p_workspace text,p_credential_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_existing sasshy_private.workspace_credentials%rowtype;
begin
  if p_workspace is null or p_workspace !~ '^[a-f0-9]{64}$'
     or p_credential_hash is null or p_credential_hash !~ '^[a-f0-9]{64}$'
     or p_workspace=p_credential_hash then raise exception 'invalid credential mapping'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sasshy-auth:'||p_workspace,0));
  if not exists(select 1 from public.sasshy_v2_records where workspace_hash=p_workspace) then
    raise exception 'existing workspace required';
  end if;
  if exists(select 1 from public.sasshy_v2_records where workspace_hash=p_credential_hash)
     or exists(select 1 from sasshy_private.workspace_auth where workspace_hash=p_credential_hash) then
    raise exception 'credential collides with workspace';
  end if;
  insert into sasshy_private.workspace_credentials(credential_hash,workspace_hash)
    values(p_credential_hash,p_workspace) on conflict(credential_hash) do nothing;
  select * into v_existing from sasshy_private.workspace_credentials where credential_hash=p_credential_hash;
  if v_existing.workspace_hash is distinct from p_workspace or v_existing.revoked_at is not null then
    raise exception 'credential mapping cannot be reassigned or revived';
  end if;
end;
$$;
revoke all on function sasshy_private.stage_credential(text,text) from public,anon,authenticated,service_role;

create or replace function sasshy_private.disable_legacy_credential(p_workspace text,p_confirmed_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('sasshy-auth:'||p_workspace,0));
  if not exists(select 1 from sasshy_private.workspace_credentials
    where credential_hash=p_confirmed_hash and workspace_hash=p_workspace and revoked_at is null) then
    raise exception 'verified replacement credential required';
  end if;
  insert into sasshy_private.workspace_auth(workspace_hash) values(p_workspace) on conflict do nothing;
end;
$$;
revoke all on function sasshy_private.disable_legacy_credential(text,text) from public,anon,authenticated,service_role;

create or replace function sasshy_private.revoke_credential(p_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update sasshy_private.workspace_credentials set revoked_at=coalesce(revoked_at,now()) where credential_hash=p_hash;
  if not found then raise exception 'credential mapping not found'; end if;
end;
$$;
revoke all on function sasshy_private.revoke_credential(text) from public,anon,authenticated,service_role;
