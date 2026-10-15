-- Additive, service-role-only RPC. Existing tables, sync and task APIs stay intact.
-- p_task=null is a read-only retry lookup; creation is atomic with metadata.
create or replace function public.sasshy_v2_ingest_voice_task(
  p_sync_key text, p_idempotency_key text, p_transcript text, p_task jsonb default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
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
$$;
revoke all on function public.sasshy_v2_ingest_voice_task(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.sasshy_v2_ingest_voice_task(text,text,text,jsonb) to service_role;
