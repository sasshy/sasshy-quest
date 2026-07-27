-- SASSHY v2: record-by-record sync.
-- Run this once in Supabase SQL Editor. It does not touch the old app_state table.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sasshy_v2_records (
  workspace_hash text not null,
  record_type text not null check (record_type in ('task', 'session', 'memo')),
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_hash, record_type, id)
);

create table if not exists public.sasshy_v2_history (
  history_id bigint generated always as identity primary key,
  workspace_hash text not null,
  record_type text not null,
  record_id text not null,
  payload jsonb not null,
  deleted boolean not null,
  recorded_at timestamptz not null default now()
);

alter table public.sasshy_v2_records enable row level security;
alter table public.sasshy_v2_history enable row level security;

revoke all on public.sasshy_v2_records from anon, authenticated;
revoke all on public.sasshy_v2_history from anon, authenticated;

create or replace function public.sasshy_v2_push(
  p_sync_key text,
  p_record_type text,
  p_id text,
  p_payload jsonb,
  p_deleted boolean default false
)
returns setof public.sasshy_v2_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := encode(extensions.digest(p_sync_key, 'sha256'), 'hex');
  v_old public.sasshy_v2_records%rowtype;
begin
  if length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if p_record_type not in ('task', 'session', 'memo') then
    raise exception 'invalid record type';
  end if;

  select * into v_old
  from public.sasshy_v2_records
  where workspace_hash = v_hash and record_type = p_record_type and id = p_id;

  if found then
    insert into public.sasshy_v2_history(workspace_hash, record_type, record_id, payload, deleted)
    values(v_old.workspace_hash, v_old.record_type, v_old.id, v_old.payload, v_old.deleted);
  end if;

  insert into public.sasshy_v2_records(workspace_hash, record_type, id, payload, deleted, updated_at)
  values(v_hash, p_record_type, p_id, p_payload, p_deleted, now())
  on conflict (workspace_hash, record_type, id)
  do update set payload = excluded.payload, deleted = excluded.deleted, updated_at = now();

  return query
  select * from public.sasshy_v2_records
  where workspace_hash = v_hash and record_type = p_record_type and id = p_id;
end;
$$;

create or replace function public.sasshy_v2_pull(p_sync_key text)
returns setof public.sasshy_v2_records
language sql
security definer
stable
set search_path = public
as $$
  select *
  from public.sasshy_v2_records
  where workspace_hash = encode(extensions.digest(p_sync_key, 'sha256'), 'hex')
  order by updated_at asc;
$$;

revoke all on function public.sasshy_v2_push(text, text, text, jsonb, boolean) from public;
revoke all on function public.sasshy_v2_pull(text) from public;
grant execute on function public.sasshy_v2_push(text, text, text, jsonb, boolean) to anon, authenticated;
grant execute on function public.sasshy_v2_pull(text) to anon, authenticated;
