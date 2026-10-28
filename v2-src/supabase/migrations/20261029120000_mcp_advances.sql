-- 立て替えを Claude / ChatGPT（MCP）から見る・「返ってきた」にする。
-- 書き換えるのは expense.advance.repaidAt だけ（金額や品名は変えない）。

create or replace function public.sasshy_v2_action_list_advances(p_sync_key text, p_include_repaid boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_hash text;
  v_rows jsonb;
begin
  if p_sync_key is null or length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  v_hash := sasshy_private.resolve_credential(p_sync_key);
  select coalesce(jsonb_agg(jsonb_build_object(
      'memo_id', r.id,
      'who', r.payload->'expense'->'advance'->>'who',
      'item', r.payload->'expense'->>'item',
      'amount', (r.payload->'expense'->>'amount')::numeric,
      'paid_at', r.payload->'expense'->>'at',
      'repaid_at', r.payload->'expense'->'advance'->>'repaidAt'
    ) order by r.payload->'expense'->>'at' desc), '[]'::jsonb)
    into v_rows
    from public.sasshy_v2_records r
    where r.workspace_hash = v_hash and r.record_type = 'memo' and not r.deleted
      and r.payload->>'deletedAt' is null
      and r.payload->'expense'->>'bucket' = 'advance'
      and jsonb_typeof(r.payload->'expense'->'advance') = 'object'
      and (p_include_repaid or r.payload->'expense'->'advance'->>'repaidAt' is null);
  return jsonb_build_object(
    'advances', v_rows,
    'count', jsonb_array_length(v_rows),
    'total', coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(v_rows) x where x->>'repaid_at' is null), 0)
  );
end;
$function$;

create or replace function public.sasshy_v2_action_set_advance_repaid(p_sync_key text, p_memo_ids jsonb, p_repaid boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_hash text;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_now_text text;
  v_id text;
  v_row public.sasshy_v2_records%rowtype;
  v_payload jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
begin
  if p_sync_key is null or length(p_sync_key) < 12 then
    raise exception 'sync key must be at least 12 characters';
  end if;
  if p_memo_ids is null or jsonb_typeof(p_memo_ids) <> 'array'
    or jsonb_array_length(p_memo_ids) not between 1 and 20 or p_repaid is null then
    raise exception 'invalid advance request';
  end if;
  v_hash := sasshy_private.resolve_credential(p_sync_key);
  v_now_text := to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  for v_id in select value from jsonb_array_elements_text(p_memo_ids) loop
    if coalesce(length(v_id), 0) not between 1 and 200 then
      raise exception 'invalid memo id';
    end if;
    select * into v_row from public.sasshy_v2_records
      where workspace_hash = v_hash and record_type = 'memo' and id = v_id
      for update;
    if not found or v_row.deleted
      or v_row.payload->'expense'->>'bucket' is distinct from 'advance'
      or jsonb_typeof(v_row.payload->'expense'->'advance') is distinct from 'object' then
      v_missing := v_missing || to_jsonb(v_id);
      continue;
    end if;

    v_payload := jsonb_set(v_row.payload, '{expense,advance,repaidAt}',
      case when p_repaid then to_jsonb(v_now_text) else 'null'::jsonb end, true);
    v_payload := v_payload || jsonb_build_object('updatedAt', v_now_text);
    v_payload := jsonb_set(v_payload, '{sync}',
      coalesce(v_payload->'sync', '{}'::jsonb) || jsonb_build_object('deviceId', 'chatgpt-action'), true);

    insert into public.sasshy_v2_history(workspace_hash, record_type, record_id, payload, deleted)
      values (v_row.workspace_hash, v_row.record_type, v_row.id, v_row.payload, v_row.deleted);
    update public.sasshy_v2_records set payload = v_payload, updated_at = v_now
      where workspace_hash = v_hash and record_type = 'memo' and id = v_row.id;
    v_updated := v_updated || jsonb_build_array(jsonb_build_object(
      'memo_id', v_row.id,
      'who', v_payload->'expense'->'advance'->>'who',
      'item', v_payload->'expense'->>'item',
      'amount', (v_payload->'expense'->>'amount')::numeric));
  end loop;

  return jsonb_build_object('ok', true, 'updated', v_updated, 'not_found', v_missing);
end;
$function$;

revoke all on function public.sasshy_v2_action_list_advances(text, boolean) from public, anon, authenticated;
revoke all on function public.sasshy_v2_action_set_advance_repaid(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.sasshy_v2_action_list_advances(text, boolean) to service_role;
grant execute on function public.sasshy_v2_action_set_advance_repaid(text, jsonb, boolean) to service_role;
