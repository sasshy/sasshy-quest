-- SASSHY v2 calendar history: append-only schedule events and atomic task updates.
-- Apply after supabase-setup.sql. This does not add a record_type to generic pull.

create table if not exists public.sasshy_v2_schedule_history (
  workspace_hash text not null,
  id text not null,
  task_id text not null,
  operation_group_id text,
  before_version_id text,
  after_version_id text,
  target_version_id text,
  operation text not null check (operation in (
    'schedule', 'reschedule', 'adjust_date', 'adjust_time', 'adjust_duration',
    'unschedule', 'set_result', 'correct_result', 'revert', 'reapply', 'resolve_conflict'
  )),
  result text not null default 'unconfirmed' check (result in (
    'unconfirmed', 'completed', 'not_done', 'cancelled', 'skipped'
  )),
  before_schedule jsonb,
  after_schedule jsonb,
  title text not null default '',
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  device_id text not null default '',
  source text not null default 'external' check (source in ('local', 'remote', 'external')),
  related_entry_id text,
  reason text not null default '',
  primary key (workspace_hash, id)
);

create index if not exists sasshy_v2_schedule_history_task_time_idx
  on public.sasshy_v2_schedule_history(workspace_hash, task_id, occurred_at);

create index if not exists sasshy_v2_schedule_history_target_version_idx
  on public.sasshy_v2_schedule_history(workspace_hash, target_version_id)
  where target_version_id is not null;

alter table public.sasshy_v2_schedule_history enable row level security;
revoke all on public.sasshy_v2_schedule_history from public, anon, authenticated;
grant select, insert, update on public.sasshy_v2_schedule_history to service_role;

create or replace function public.sasshy_v2_capture_schedule_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

drop trigger if exists sasshy_v2_capture_schedule_change_trigger on public.sasshy_v2_records;
create trigger sasshy_v2_capture_schedule_change_trigger
before insert or update of payload on public.sasshy_v2_records
for each row execute function public.sasshy_v2_capture_schedule_change();

revoke all on function public.sasshy_v2_capture_schedule_change() from public, anon, authenticated;

create or replace function public.sasshy_v2_apply_schedule_change(
  p_sync_key text,
  p_operation_id text,
  p_task_id text,
  p_base_revision timestamptz,
  p_task jsonb,
  p_update_task boolean,
  p_history jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function public.sasshy_v2_apply_schedule_change(
  text, text, text, timestamptz, jsonb, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.sasshy_v2_apply_schedule_change(
  text, text, text, timestamptz, jsonb, boolean, jsonb
) to service_role;
