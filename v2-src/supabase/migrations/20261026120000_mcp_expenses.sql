-- 支出をClaude / ChatGPT（MCP）から記録・確認する。食事（sasshy_v2_ingest_meals）と同じ作り。

create or replace function public.sasshy_v2_ingest_expenses(p_sync_key text, p_idempotency_key text, p_memos jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_now timestamptz := now();
  v_now_text text := to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_hash text;
  v_key text;
  v_base text;
  v_fingerprint text;
  v_existing public.sasshy_v2_ingest_requests%rowtype;
  v_memo jsonb;
  v_payload jsonb;
  v_saved jsonb := '[]'::jsonb;
  v_index integer := 0;
begin
  if p_sync_key is null or length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,120}$' then
    raise exception 'invalid idempotency key';
  end if;
  if p_memos is null or jsonb_typeof(p_memos) <> 'array'
    or jsonb_array_length(p_memos) not between 1 and 20
    or length(p_memos::text) > 16000 then
    raise exception 'invalid expense request';
  end if;

  v_hash := sasshy_private.resolve_credential(p_sync_key);
  v_key := 'expense:' || p_idempotency_key;
  v_base := 'memo-chatgpt-' || substring(
    encode(extensions.digest(v_hash || ':' || v_key, 'sha256'), 'hex'), 1, 24);
  v_fingerprint := encode(extensions.digest(p_memos::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(v_hash || ':' || v_key, 0));
  select * into v_existing from public.sasshy_v2_ingest_requests
    where workspace_hash = v_hash and idempotency_key = v_key;
  if found then
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      raise exception 'idempotency key was already used for different content';
    end if;
    select coalesce(jsonb_agg(r.payload order by r.id), '[]'::jsonb) into v_saved
      from public.sasshy_v2_records r
      where r.workspace_hash = v_hash and r.record_type = 'memo' and r.id like v_base || '-%';
    return jsonb_build_object('memos', v_saved, 'duplicate', true);
  end if;

  for v_memo in select value from jsonb_array_elements(p_memos) loop
    if jsonb_typeof(v_memo) <> 'object'
      or v_memo->>'category' is distinct from '支出'
      or jsonb_typeof(v_memo->'expense') is distinct from 'object'
      or coalesce(length(trim(v_memo->'expense'->>'item')), 0) not between 1 and 120
      or jsonb_typeof(v_memo->'expense'->'amount') is distinct from 'number'
      or (v_memo->'expense'->>'amount')::numeric not between 0 and 10000000
      or coalesce(length(v_memo->>'title'), 0) not between 1 and 300
      or (v_memo->'expense'->>'at') !~ '^\d{4}-\d{2}-\d{2}T' then
      raise exception 'invalid expense memo';
    end if;
    perform (v_memo->'expense'->>'at')::timestamptz;

    v_index := v_index + 1;
    v_payload := jsonb_build_object(
      'id', v_base || '-' || lpad(v_index::text, 2, '0'),
      'title', v_memo->>'title',
      'body', '',
      'category', '支出',
      'pinned', false,
      'reminderAt', null,
      'archived', false,
      'expense', v_memo->'expense',
      'createdAt', v_now_text,
      'updatedAt', v_now_text,
      'deletedAt', null,
      'source', 'v2',
      'sync', jsonb_build_object('deviceId', 'chatgpt-action')
    );
    insert into public.sasshy_v2_records(workspace_hash, record_type, id, payload, deleted, updated_at)
      values (v_hash, 'memo', v_payload->>'id', v_payload, false, v_now);
    v_saved := v_saved || jsonb_build_array(v_payload);
  end loop;

  insert into public.sasshy_v2_ingest_requests(workspace_hash, idempotency_key, task_id, request_fingerprint)
    values (v_hash, v_key, v_base, v_fingerprint);

  return jsonb_build_object('memos', v_saved, 'duplicate', false);
end;
$function$;

create or replace function public.sasshy_v2_action_search_expenses(p_sync_key text, p_from_date date, p_to_date date, p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_hash text;
  v_items jsonb;
begin
  if p_sync_key is null or length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid limit';
  end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date or p_to_date - p_from_date > 92 then
    raise exception 'invalid date range';
  end if;

  v_hash := sasshy_private.resolve_credential(p_sync_key);

  select coalesce(jsonb_agg(x.item order by x.paid_at), '[]'::jsonb) into v_items
  from (
    select r.payload->'expense'->>'at' as paid_at,
      jsonb_build_object(
        'memo_id', r.id,
        'paid_at', r.payload->'expense'->'at',
        'item', r.payload->'expense'->'item',
        'amount', r.payload->'expense'->'amount',
        'category', r.payload->'expense'->'category'
      ) as item
    from public.sasshy_v2_records r
    where r.workspace_hash = v_hash
      and r.record_type = 'memo'
      and not r.deleted
      and r.payload->>'category' = '支出'
      and jsonb_typeof(r.payload->'expense') = 'object'
      and r.payload->>'deletedAt' is null
      and coalesce(r.payload->>'archived', 'false') <> 'true'
      and ((r.payload->'expense'->>'at')::timestamptz at time zone 'Asia/Tokyo')::date between p_from_date and p_to_date
    order by r.payload->'expense'->>'at'
    limit p_limit
  ) x;

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_items),
    'total', coalesce((select sum((e->>'amount')::numeric) from jsonb_array_elements(v_items) e), 0),
    'expenses', v_items);
end;
$function$;

revoke all on function public.sasshy_v2_ingest_expenses(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sasshy_v2_action_search_expenses(text, date, date, integer) from public, anon, authenticated;
grant execute on function public.sasshy_v2_ingest_expenses(text, text, jsonb) to service_role;
grant execute on function public.sasshy_v2_action_search_expenses(text, date, date, integer) to service_role;
