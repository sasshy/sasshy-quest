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

-- ChatGPTなど外部の追加専用入口で、再送による二重登録を防ぐための受付記録。
-- タスク本文はここへ重複保存せず、受付番号と作成したタスクIDだけを保持する。
create table if not exists public.sasshy_v2_ingest_requests (
  workspace_hash text not null,
  idempotency_key text not null,
  task_id text not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_hash, idempotency_key)
);

alter table public.sasshy_v2_records enable row level security;
alter table public.sasshy_v2_history enable row level security;
alter table public.sasshy_v2_ingest_requests enable row level security;

revoke all on public.sasshy_v2_records from anon, authenticated;
revoke all on public.sasshy_v2_history from anon, authenticated;
revoke all on public.sasshy_v2_ingest_requests from anon, authenticated;

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

-- Edge Function専用。ブラウザのpublishable keyからは直接実行できない。
create or replace function public.sasshy_v2_ingest_task(
  p_sync_key text,
  p_idempotency_key text,
  p_title text,
  p_notes text default '',
  p_horizon text default 'now',
  p_scheduled_date date default null,
  p_start_minute integer default null,
  p_duration_min integer default 25,
  p_importance integer default 0,
  p_urgency integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_hash text := encode(extensions.digest(p_sync_key, 'sha256'), 'hex');
  v_task_id text := 'task-chatgpt-' || substring(
    encode(extensions.digest(p_sync_key || ':' || p_idempotency_key, 'sha256'), 'hex'),
    1,
    32
  );
  v_fingerprint text := encode(extensions.digest(
    concat_ws(
      '|',
      trim(p_title),
      coalesce(trim(p_notes), ''),
      p_horizon,
      coalesce(p_scheduled_date::text, ''),
      coalesce(p_start_minute::text, ''),
      p_duration_min::text,
      p_importance::text,
      p_urgency::text
    ),
    'sha256'
  ), 'hex');
  v_existing_fingerprint text;
  v_existing_task_id text;
  v_payload jsonb;
  v_inserted integer;
begin
  if length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if length(p_idempotency_key) < 8 or length(p_idempotency_key) > 128 then
    raise exception 'invalid idempotency key';
  end if;
  if length(trim(p_title)) < 1 or length(trim(p_title)) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if length(coalesce(p_notes, '')) > 4000 then
    raise exception 'notes must be at most 4000 characters';
  end if;
  if p_horizon not in ('now', 'someday', 'wish', 'waiting') then
    raise exception 'invalid horizon';
  end if;
  if p_start_minute is not null and (p_start_minute < 0 or p_start_minute > 1439) then
    raise exception 'invalid start minute';
  end if;
  if p_start_minute is not null and p_scheduled_date is null then
    raise exception 'start time requires a scheduled date';
  end if;
  if p_duration_min < 5 or p_duration_min > 720 then
    raise exception 'duration must be between 5 and 720 minutes';
  end if;
  if p_importance not between 0 and 2 or p_urgency not between 0 and 2 then
    raise exception 'invalid priority';
  end if;

  insert into public.sasshy_v2_ingest_requests(
    workspace_hash,
    idempotency_key,
    task_id,
    request_fingerprint
  )
  values(v_hash, p_idempotency_key, v_task_id, v_fingerprint)
  on conflict (workspace_hash, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select task_id, request_fingerprint
    into v_existing_task_id, v_existing_fingerprint
    from public.sasshy_v2_ingest_requests
    where workspace_hash = v_hash and idempotency_key = p_idempotency_key;

    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception 'idempotency key was already used for different content';
    end if;

    select payload
    into v_payload
    from public.sasshy_v2_records
    where workspace_hash = v_hash and record_type = 'task' and id = v_existing_task_id;

    if v_payload is null then
      raise exception 'matching request exists without a task';
    end if;

    return jsonb_build_object('task', v_payload, 'duplicate', true);
  end if;

  v_payload := jsonb_build_object(
    'id', v_task_id,
    'title', trim(p_title),
    'notes', coalesce(trim(p_notes), ''),
    'status', case when p_scheduled_date is null then 'inbox' else 'planned' end,
    'horizon', p_horizon,
    'scheduledDate', case when p_scheduled_date is null then null else to_char(p_scheduled_date, 'YYYY-MM-DD') end,
    'startMinute', p_start_minute,
    'durationMin', p_duration_min,
    'estimateMin', p_duration_min,
    'importance', p_importance,
    'urgency', p_urgency,
    'createdAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'completedAt', null,
    'deletedAt', null,
    'source', 'v2',
    'sync', jsonb_build_object('deviceId', 'chatgpt-action')
  );

  insert into public.sasshy_v2_records(
    workspace_hash,
    record_type,
    id,
    payload,
    deleted,
    updated_at
  )
  values(v_hash, 'task', v_task_id, v_payload, false, v_now);

  return jsonb_build_object('task', v_payload, 'duplicate', false);
end;
$$;

revoke all on function public.sasshy_v2_ingest_task(
  text, text, text, text, text, date, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.sasshy_v2_ingest_task(
  text, text, text, text, text, date, integer, integer, integer, integer
) to service_role;
