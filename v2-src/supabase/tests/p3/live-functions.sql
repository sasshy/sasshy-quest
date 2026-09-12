CREATE OR REPLACE FUNCTION public.sasshy_v2_action_mutate_task(p_sync_key text, p_task_id text, p_expected_updated_at timestamp with time zone, p_operation text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_action_search_tasks(p_sync_key text, p_query text, p_from_date date, p_to_date date, p_status text, p_include_deleted boolean, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_apply_schedule_change(p_sync_key text, p_operation_id text, p_task_id text, p_base_revision timestamp with time zone, p_task jsonb, p_update_task boolean, p_history jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_hash text := encode(extensions.digest(p_sync_key, 'sha256'), 'hex');
  v_row public.sasshy_v2_records%rowtype;
  v_existing public.sasshy_v2_schedule_history%rowtype;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
begin
  if length(p_sync_key) < 12 then raise exception 'invalid sync key'; end if;
  if p_operation_id !~ '^[A-Za-z0-9._:-]{1,240}$' then raise exception 'invalid operation id'; end if;
  if p_task_id !~ '^[A-Za-z0-9._:-]{1,200}$' then raise exception 'invalid task id'; end if;
  if p_history->>'id' is distinct from p_operation_id or p_history->>'taskId' is distinct from p_task_id then
    raise exception 'history identity mismatch';
  end if;

  select * into v_existing
  from public.sasshy_v2_schedule_history
  where workspace_hash = v_hash and id = p_operation_id;
  if found and v_existing.source <> 'external' then
    select * into v_row from public.sasshy_v2_records
    where workspace_hash = v_hash and record_type = 'task' and id = p_task_id;
    return jsonb_build_object(
      'ok', true,
      'revision', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'task', v_row.payload,
      'history', p_history || jsonb_build_object('serverReceivedAt', to_char(v_existing.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    );
  end if;

  select * into v_row
  from public.sasshy_v2_records
  where workspace_hash = v_hash and record_type = 'task' and id = p_task_id
  for update;

  if p_update_task then
    if found and (p_base_revision is null or v_row.updated_at is distinct from p_base_revision) then
      return jsonb_build_object(
        'ok', false,
        'conflict', true,
        'serverRevision', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'serverTask', v_row.payload
      );
    end if;
    if not found and p_base_revision is not null then
      return jsonb_build_object('ok', false, 'conflict', true, 'serverRevision', null, 'serverTask', null);
    end if;
    perform set_config('sasshy.schedule_operation_id', p_operation_id, true);
    insert into public.sasshy_v2_records(workspace_hash, record_type, id, payload, deleted, updated_at)
    values(v_hash, 'task', p_task_id, p_task, (p_task->>'deletedAt') is not null, v_now)
    on conflict (workspace_hash, record_type, id)
    do update set payload = excluded.payload, deleted = excluded.deleted, updated_at = excluded.updated_at;
  elsif not found then
    return jsonb_build_object('ok', false, 'conflict', true, 'serverRevision', null, 'serverTask', null);
  elsif p_base_revision is not null and v_row.updated_at is distinct from p_base_revision then
    return jsonb_build_object(
      'ok', false,
      'conflict', true,
      'serverRevision', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'serverTask', v_row.payload
    );
  end if;

  insert into public.sasshy_v2_schedule_history (
    workspace_hash, id, task_id, operation_group_id, before_version_id,
    after_version_id, target_version_id, operation, result, before_schedule,
    after_schedule, title, occurred_at, received_at, device_id, source,
    related_entry_id, reason
  ) values (
    v_hash,
    p_operation_id,
    p_task_id,
    nullif(p_history->>'operationGroupId', ''),
    nullif(p_history->>'beforeVersionId', ''),
    nullif(p_history->>'afterVersionId', ''),
    nullif(p_history->>'targetVersionId', ''),
    p_history->>'operation',
    coalesce(p_history->>'result', 'unconfirmed'),
    p_history->'before',
    p_history->'after',
    left(coalesce(p_history->>'title', ''), 240),
    coalesce(nullif(p_history->>'occurredAt', '')::timestamptz, v_now),
    v_now,
    left(coalesce(p_history->>'deviceId', ''), 240),
    case when p_history->>'source' in ('local', 'remote', 'external') then p_history->>'source' else 'local' end,
    nullif(p_history->>'relatedEntryId', ''),
    left(coalesce(p_history->>'reason', ''), 1000)
  )
  on conflict (workspace_hash, id) do update set
    operation_group_id = excluded.operation_group_id,
    before_version_id = excluded.before_version_id,
    after_version_id = excluded.after_version_id,
    target_version_id = excluded.target_version_id,
    operation = excluded.operation,
    result = excluded.result,
    before_schedule = excluded.before_schedule,
    after_schedule = excluded.after_schedule,
    title = excluded.title,
    occurred_at = excluded.occurred_at,
    received_at = excluded.received_at,
    device_id = excluded.device_id,
    source = excluded.source,
    related_entry_id = excluded.related_entry_id,
    reason = excluded.reason
  where public.sasshy_v2_schedule_history.source = 'external';

  select * into v_row from public.sasshy_v2_records
  where workspace_hash = v_hash and record_type = 'task' and id = p_task_id;
  return jsonb_build_object(
    'ok', true,
    'revision', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'task', v_row.payload,
    'history', p_history || jsonb_build_object('serverReceivedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_capture_schedule_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_old_date text := case when tg_op = 'INSERT' then null else old.payload->>'scheduledDate' end;
  v_old_minute text := case when tg_op = 'INSERT' then null else old.payload->>'startMinute' end;
  v_old_duration text := case when tg_op = 'INSERT' then null else old.payload->>'durationMin' end;
  v_new_date text := new.payload->>'scheduledDate';
  v_new_minute text := new.payload->>'startMinute';
  v_new_duration text := new.payload->>'durationMin';
  v_old_version text := case when tg_op = 'INSERT' then null else old.payload->>'scheduleVersionId' end;
  v_new_version text := new.payload->>'scheduleVersionId';
  v_operation text;
  v_operation_id text;
  v_context_id text := nullif(current_setting('sasshy.schedule_operation_id', true), '');
begin
  if new.record_type <> 'task' then return new; end if;

  if v_new_date is not null and v_new_version is null then
    v_new_version := 'schedule-server-' || gen_random_uuid()::text;
    new.payload := jsonb_set(new.payload, '{scheduleVersionId}', to_jsonb(v_new_version), true);
  elsif v_new_date is null then
    new.payload := jsonb_set(new.payload, '{scheduleVersionId}', 'null'::jsonb, true);
    v_new_version := null;
  end if;

  if tg_op = 'UPDATE'
    and v_old_date is not distinct from v_new_date
    and v_old_minute is not distinct from v_new_minute
    and v_old_duration is not distinct from v_new_duration then
    return new;
  end if;
  if tg_op = 'INSERT' and v_new_date is null then return new; end if;

  if v_old_date is null and v_new_date is not null then
    v_operation := 'schedule';
  elsif v_old_date is not null and v_new_date is null then
    v_operation := 'unschedule';
  elsif v_old_date is distinct from v_new_date and (
    v_old_minute is distinct from v_new_minute or v_old_duration is distinct from v_new_duration
  ) then
    v_operation := 'reschedule';
  elsif v_old_date is distinct from v_new_date then
    v_operation := 'adjust_date';
  elsif v_old_minute is distinct from v_new_minute then
    v_operation := 'adjust_time';
  else
    v_operation := 'adjust_duration';
  end if;

  if tg_op = 'UPDATE' and v_new_date is not null and v_new_version is not distinct from v_old_version then
    v_new_version := 'schedule-server-' || gen_random_uuid()::text;
    new.payload := jsonb_set(new.payload, '{scheduleVersionId}', to_jsonb(v_new_version), true);
  end if;
  v_operation_id := coalesce(v_context_id, 'schedule-external-' || gen_random_uuid()::text);

  insert into public.sasshy_v2_schedule_history (
    workspace_hash, id, task_id, before_version_id, after_version_id,
    operation, result, before_schedule, after_schedule, title,
    occurred_at, device_id, source
  ) values (
    new.workspace_hash,
    v_operation_id,
    new.id,
    v_old_version,
    v_new_version,
    v_operation,
    'unconfirmed',
    case when tg_op = 'INSERT' then null else jsonb_build_object(
      'scheduleVersionId', v_old_version,
      'scheduledDate', v_old_date,
      'startMinute', old.payload->'startMinute',
      'durationMin', old.payload->'durationMin',
      'title', coalesce(old.payload->>'title', '')
    ) end,
    jsonb_build_object(
      'scheduleVersionId', v_new_version,
      'scheduledDate', v_new_date,
      'startMinute', new.payload->'startMinute',
      'durationMin', new.payload->'durationMin',
      'title', coalesce(new.payload->>'title', '')
    ),
    coalesce(new.payload->>'title', ''),
    now(),
    coalesce(new.payload->'sync'->>'deviceId', 'external'),
    'external'
  ) on conflict (workspace_hash, id) do nothing;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_ingest_task(p_sync_key text, p_idempotency_key text, p_title text, p_notes text DEFAULT ''::text, p_horizon text DEFAULT 'now'::text, p_scheduled_date date DEFAULT NULL::date, p_start_minute integer DEFAULT NULL::integer, p_duration_min integer DEFAULT 25, p_importance integer DEFAULT 0, p_urgency integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_ingest_voice_task(p_sync_key text, p_idempotency_key text, p_transcript text, p_task jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_hash text := encode(extensions.digest(p_sync_key, 'sha256'), 'hex');
  v_key text := 'voice:' || p_idempotency_key;
  v_fingerprint text := encode(extensions.digest(p_transcript, 'sha256'), 'hex');
  v_existing public.sasshy_v2_ingest_requests%rowtype;
  v_result jsonb;
  v_payload jsonb;
begin
  if p_sync_key is null or length(p_sync_key) < 12 or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,120}$'
    or p_transcript is null or length(trim(p_transcript)) not between 1 and 4000 then
    raise exception 'invalid voice request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_hash || ':' || v_key, 0));
  select * into v_existing from public.sasshy_v2_ingest_requests
    where workspace_hash = v_hash and idempotency_key = v_key;
  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'idempotency key was already used for different content';
    end if;
    select payload into v_payload from public.sasshy_v2_records
      where workspace_hash = v_hash and record_type = 'task' and id = v_existing.task_id;
    if v_payload is null then raise exception 'matching request exists without a task'; end if;
    return jsonb_build_object('task', v_payload, 'duplicate', true);
  end if;
  if p_task is null then return null; end if;
  if jsonb_typeof(p_task) <> 'object' or coalesce(length(trim(p_task->>'title')),0) not between 1 and 200
    or coalesce(length(p_task->>'counterparty'),0) > 200 or coalesce(length(p_task->>'requestSource'),0) > 200
    or coalesce(length(p_task->>'notes'),0) > 4000 then raise exception 'invalid voice task'; end if;
  if p_task->>'dueDate' is not null then
    if p_task->>'dueDate' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid due date'; end if;
    perform (p_task->>'dueDate')::date;
  end if;
  if p_task->>'dueTime' is not null and (p_task->>'dueDate' is null or p_task->>'dueTime' !~ '^([01]\d|2[0-3]):[0-5]\d$') then
    raise exception 'invalid due time';
  end if;
  -- Reuse established single-record creation, history and idempotency storage.
  v_result := public.sasshy_v2_ingest_task(p_sync_key, v_key, p_task->>'title', coalesce(p_task->>'notes',''));
  v_payload := (v_result->'task') || jsonb_build_object(
    'dueDate', p_task->>'dueDate', 'dueTime', p_task->>'dueTime',
    'counterparty', coalesce(p_task->>'counterparty',''),
    'requestSource', coalesce(p_task->>'requestSource',''),
    'voiceTranscript', p_transcript, 'reminderEnabled', true, 'reminderAfter', null
  );
  update public.sasshy_v2_records set payload = v_payload
    where workspace_hash = v_hash and record_type = 'task' and id = v_payload->>'id';
  update public.sasshy_v2_ingest_requests set request_fingerprint = v_fingerprint
    where workspace_hash = v_hash and idempotency_key = v_key;
  return jsonb_build_object('task', v_payload, 'duplicate', false);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_pull(p_sync_key text)
 RETURNS SETOF sasshy_v2_records
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select *
  from public.sasshy_v2_records
  where workspace_hash = encode(extensions.digest(p_sync_key, 'sha256'), 'hex')
  order by updated_at asc;
$function$
;

CREATE OR REPLACE FUNCTION public.sasshy_v2_push(p_sync_key text, p_record_type text, p_id text, p_payload jsonb, p_deleted boolean DEFAULT false)
 RETURNS SETOF sasshy_v2_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
