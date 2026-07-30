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

-- ChatGPT管理用の検索。タスク以外（メモ・タイマー履歴）は返さない。
create or replace function public.sasshy_v2_action_search_tasks(
  p_sync_key text,
  p_query text,
  p_from_date date,
  p_to_date date,
  p_status text,
  p_include_deleted boolean,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := encode(extensions.digest(p_sync_key, 'sha256'), 'hex');
  v_tasks jsonb;
begin
  if length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if p_status not in ('open', 'done', 'deleted', 'all') then
    raise exception 'invalid status';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'invalid limit';
  end if;
  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'invalid date range';
  end if;

  select coalesce(jsonb_agg(item order by sort_date asc nulls last, sort_minute asc, title asc), '[]'::jsonb)
  into v_tasks
  from (
    select
      jsonb_build_object(
        'id', r.id,
        'title', r.payload->>'title',
        'notes', coalesce(r.payload->>'notes', ''),
        'status', r.payload->>'status',
        'horizon', r.payload->>'horizon',
        'scheduled_date', r.payload->>'scheduledDate',
        'start_time', case
          when r.payload->>'startMinute' is null then null
          else lpad(((r.payload->>'startMinute')::integer / 60)::text, 2, '0')
            || ':' || lpad(((r.payload->>'startMinute')::integer % 60)::text, 2, '0')
        end,
        'duration_min', (r.payload->>'durationMin')::integer,
        'importance', coalesce((r.payload->>'importance')::integer, 0),
        'urgency', coalesce((r.payload->>'urgency')::integer, 0),
        'completed_at', r.payload->>'completedAt',
        'deleted_at', r.payload->>'deletedAt',
        'revision', to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) as item,
      r.payload->>'scheduledDate' as sort_date,
      coalesce((r.payload->>'startMinute')::integer, 1440) as sort_minute,
      r.payload->>'title' as title
    from public.sasshy_v2_records r
    where r.workspace_hash = v_hash
      and r.record_type = 'task'
      and (
        p_status = 'all'
        or (p_status = 'deleted' and r.deleted)
        or (
          p_status = 'done'
          and not r.deleted
          and r.payload->>'status' = 'done'
        )
        or (
          p_status = 'open'
          and not r.deleted
          and coalesce(r.payload->>'status', '') not in ('done', 'archived')
        )
      )
      and (p_include_deleted or p_status = 'deleted' or not r.deleted)
      and (
        coalesce(trim(p_query), '') = ''
        or coalesce(r.payload->>'title', '') ilike '%' || trim(p_query) || '%'
        or coalesce(r.payload->>'notes', '') ilike '%' || trim(p_query) || '%'
      )
      and (
        p_from_date is null
        or (
          r.payload->>'scheduledDate' is not null
          and (r.payload->>'scheduledDate')::date >= p_from_date
        )
      )
      and (
        p_to_date is null
        or (
          r.payload->>'scheduledDate' is not null
          and (r.payload->>'scheduledDate')::date <= p_to_date
        )
      )
    limit p_limit
  ) matched;

  return jsonb_build_object(
    'ok', true,
    'count', jsonb_array_length(v_tasks),
    'tasks', v_tasks
  );
end;
$$;

revoke all on function public.sasshy_v2_action_search_tasks(
  text, text, date, date, text, boolean, integer
) from public, anon, authenticated;
grant execute on function public.sasshy_v2_action_search_tasks(
  text, text, date, date, text, boolean, integer
) to service_role;

-- ChatGPT管理用の単一タスク更新。revision一致を必須にして、端末側の新しい変更を上書きしない。
create or replace function public.sasshy_v2_action_mutate_task(
  p_sync_key text,
  p_task_id text,
  p_expected_updated_at timestamptz,
  p_operation text,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := encode(extensions.digest(p_sync_key, 'sha256'), 'hex');
  v_row public.sasshy_v2_records%rowtype;
  v_payload jsonb;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_deleted boolean;
  v_invalid_key text;
begin
  if length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if length(trim(p_task_id)) < 1 or length(p_task_id) > 200 then
    raise exception 'invalid task id';
  end if;
  if p_operation not in ('update', 'complete', 'reopen', 'delete', 'restore') then
    raise exception 'invalid operation';
  end if;
  if p_expected_updated_at is null then
    raise exception 'revision is required';
  end if;
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid patch';
  end if;

  select *
  into v_row
  from public.sasshy_v2_records
  where workspace_hash = v_hash and record_type = 'task' and id = p_task_id
  for update;

  if not found then
    raise exception 'task not found';
  end if;
  if v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'task was changed since it was read';
  end if;
  if v_row.deleted and p_operation <> 'restore' then
    raise exception 'cannot mutate deleted task';
  end if;
  if not v_row.deleted and p_operation = 'restore' then
    raise exception 'cannot restore active task';
  end if;

  select key
  into v_invalid_key
  from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) as key
  where key not in (
    'title',
    'notes',
    'scheduledDate',
    'startMinute',
    'durationMin',
    'importance',
    'urgency',
    'horizon'
  )
  limit 1;
  if v_invalid_key is not null then
    raise exception 'invalid patch key';
  end if;
  if p_operation <> 'update' and p_patch <> '{}'::jsonb then
    raise exception 'patch is only allowed for update';
  end if;
  if p_operation = 'update' and p_patch = '{}'::jsonb then
    raise exception 'empty patch';
  end if;

  v_payload := v_row.payload;
  v_deleted := v_row.deleted;

  if p_operation = 'update' then
    if p_patch ? 'title' and (
      jsonb_typeof(p_patch->'title') <> 'string'
      or length(trim(p_patch->>'title')) < 1
      or length(trim(p_patch->>'title')) > 200
    ) then
      raise exception 'invalid title';
    end if;
    if p_patch ? 'notes' and (
      jsonb_typeof(p_patch->'notes') <> 'string'
      or length(p_patch->>'notes') > 4000
    ) then
      raise exception 'invalid notes';
    end if;
    if p_patch ? 'scheduledDate'
      and jsonb_typeof(p_patch->'scheduledDate') <> 'null'
      and (
        jsonb_typeof(p_patch->'scheduledDate') <> 'string'
        or (p_patch->>'scheduledDate') !~ '^\d{4}-\d{2}-\d{2}$'
      ) then
      raise exception 'invalid scheduled date';
    end if;
    if p_patch ? 'scheduledDate' and jsonb_typeof(p_patch->'scheduledDate') <> 'null' then
      perform (p_patch->>'scheduledDate')::date;
    end if;
    if p_patch ? 'startMinute'
      and jsonb_typeof(p_patch->'startMinute') <> 'null'
      and (
        jsonb_typeof(p_patch->'startMinute') <> 'number'
        or (p_patch->>'startMinute')::integer not between 0 and 1439
      ) then
      raise exception 'invalid start minute';
    end if;
    if p_patch ? 'durationMin' and (
      jsonb_typeof(p_patch->'durationMin') <> 'number'
      or (p_patch->>'durationMin')::integer not between 5 and 720
    ) then
      raise exception 'invalid duration';
    end if;
    if p_patch ? 'importance' and (
      jsonb_typeof(p_patch->'importance') <> 'number'
      or (p_patch->>'importance')::integer not between 0 and 2
    ) then
      raise exception 'invalid importance';
    end if;
    if p_patch ? 'urgency' and (
      jsonb_typeof(p_patch->'urgency') <> 'number'
      or (p_patch->>'urgency')::integer not between 0 and 2
    ) then
      raise exception 'invalid urgency';
    end if;
    if p_patch ? 'horizon' and (
      jsonb_typeof(p_patch->'horizon') <> 'string'
      or p_patch->>'horizon' not in ('now', 'someday', 'wish', 'waiting')
    ) then
      raise exception 'invalid horizon';
    end if;

    v_payload := v_payload || p_patch;
    if p_patch ? 'durationMin' then
      v_payload := jsonb_set(v_payload, '{estimateMin}', p_patch->'durationMin', true);
    end if;
    if v_payload->>'scheduledDate' is null then
      v_payload := jsonb_set(v_payload, '{startMinute}', 'null'::jsonb, true);
    end if;
    if coalesce(v_payload->>'status', '') not in ('done', 'active') then
      v_payload := jsonb_set(
        v_payload,
        '{status}',
        to_jsonb(case when v_payload->>'scheduledDate' is null then 'inbox' else 'planned' end),
        true
      );
    end if;
  elsif p_operation = 'complete' then
    v_payload := v_payload || jsonb_build_object(
      'status', 'done',
      'completedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  elsif p_operation = 'reopen' then
    v_payload := v_payload || jsonb_build_object(
      'status', case when v_payload->>'scheduledDate' is null then 'inbox' else 'planned' end,
      'completedAt', null
    );
  elsif p_operation = 'delete' then
    v_deleted := true;
    v_payload := v_payload || jsonb_build_object(
      'status', 'archived',
      'deletedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  elsif p_operation = 'restore' then
    v_deleted := false;
    v_payload := v_payload || jsonb_build_object(
      'status', case
        when v_payload->>'completedAt' is not null then 'done'
        when v_payload->>'scheduledDate' is not null then 'planned'
        else 'inbox'
      end,
      'deletedAt', null
    );
  end if;

  v_payload := v_payload || jsonb_build_object(
    'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  v_payload := jsonb_set(
    v_payload,
    '{sync}',
    coalesce(v_payload->'sync', '{}'::jsonb) || jsonb_build_object('deviceId', 'chatgpt-action'),
    true
  );

  insert into public.sasshy_v2_history(workspace_hash, record_type, record_id, payload, deleted)
  values(v_row.workspace_hash, v_row.record_type, v_row.id, v_row.payload, v_row.deleted);

  update public.sasshy_v2_records
  set payload = v_payload, deleted = v_deleted, updated_at = v_now
  where workspace_hash = v_hash and record_type = 'task' and id = p_task_id;

  return jsonb_build_object(
    'ok', true,
    'operation', p_operation,
    'task', jsonb_build_object(
      'id', p_task_id,
      'title', v_payload->>'title',
      'status', v_payload->>'status',
      'scheduled_date', v_payload->>'scheduledDate',
      'start_time', case
        when v_payload->>'startMinute' is null then null
        else lpad(((v_payload->>'startMinute')::integer / 60)::text, 2, '0')
          || ':' || lpad(((v_payload->>'startMinute')::integer % 60)::text, 2, '0')
      end,
      'duration_min', (v_payload->>'durationMin')::integer,
      'deleted_at', v_payload->>'deletedAt',
      'revision', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  );
end;
$$;

revoke all on function public.sasshy_v2_action_mutate_task(
  text, text, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.sasshy_v2_action_mutate_task(
  text, text, timestamptz, text, jsonb
) to service_role;

-- v2.3 Web Push. The Edge Function is the only process allowed to read these tables.
create table if not exists public.sasshy_v2_push_subscriptions (
  workspace_hash text not null,
  endpoint_hash text not null,
  subscription jsonb not null,
  device_name text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_hash, endpoint_hash)
);

create table if not exists public.sasshy_v2_push_deliveries (
  workspace_hash text not null,
  notification_key text not null,
  endpoint_hash text not null,
  delivered_at timestamptz,
  error text not null default '',
  created_at timestamptz not null default now(),
  primary key (workspace_hash, notification_key, endpoint_hash)
);

create index if not exists sasshy_v2_push_subscriptions_active_idx
  on public.sasshy_v2_push_subscriptions(workspace_hash)
  where active;

create index if not exists sasshy_v2_push_deliveries_created_idx
  on public.sasshy_v2_push_deliveries(created_at);

alter table public.sasshy_v2_push_subscriptions enable row level security;
alter table public.sasshy_v2_push_deliveries enable row level security;

revoke all on public.sasshy_v2_push_subscriptions from public, anon, authenticated;
revoke all on public.sasshy_v2_push_deliveries from public, anon, authenticated;
