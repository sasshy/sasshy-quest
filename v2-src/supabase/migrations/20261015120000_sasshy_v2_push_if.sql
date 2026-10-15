-- Step2: conditional record push. Writes only when the client's last-seen server
-- version (p_base_updated_at) still matches, so an older device can no longer
-- overwrite a newer change made elsewhere. The legacy sasshy_v2_push stays for
-- clients that have not been updated yet. Same auth path as sasshy_v2_push.
begin;

create or replace function public.sasshy_v2_push_if(
  p_sync_key text,
  p_record_type text,
  p_id text,
  p_payload jsonb,
  p_deleted boolean default false,
  p_base_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hash text := sasshy_private.resolve_credential(p_sync_key);
  v_old public.sasshy_v2_records%rowtype;
  v_new public.sasshy_v2_records%rowtype;
begin
  if p_record_type not in ('task', 'session', 'memo') then
    raise exception 'invalid record type';
  end if;
  if p_id is null or length(p_id) = 0 or length(p_id) > 200 then
    raise exception 'invalid record id';
  end if;

  select * into v_old
  from public.sasshy_v2_records
  where workspace_hash = v_hash and record_type = p_record_type and id = p_id
  for update;

  if found then
    if p_base_updated_at is null or v_old.updated_at is distinct from p_base_updated_at then
      return jsonb_build_object('status', 'conflict', 'row', to_jsonb(v_old) - 'workspace_hash');
    end if;
    insert into public.sasshy_v2_history(workspace_hash, record_type, record_id, payload, deleted)
    values (v_old.workspace_hash, v_old.record_type, v_old.id, v_old.payload, v_old.deleted);
    update public.sasshy_v2_records
    set payload = p_payload, deleted = p_deleted, updated_at = now()
    where workspace_hash = v_hash and record_type = p_record_type and id = p_id
    returning * into v_new;
  else
    insert into public.sasshy_v2_records(workspace_hash, record_type, id, payload, deleted, updated_at)
    values (v_hash, p_record_type, p_id, p_payload, p_deleted, now())
    on conflict (workspace_hash, record_type, id) do nothing
    returning * into v_new;
    if v_new.id is null then
      -- Another request created it in the meantime: report it instead of overwriting.
      select * into v_old from public.sasshy_v2_records
      where workspace_hash = v_hash and record_type = p_record_type and id = p_id;
      return jsonb_build_object('status', 'conflict', 'row', to_jsonb(v_old) - 'workspace_hash');
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'row', to_jsonb(v_new) - 'workspace_hash');
end;
$function$;

revoke all on function public.sasshy_v2_push_if(text, text, text, jsonb, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.sasshy_v2_push_if(text, text, text, jsonb, boolean, timestamptz) to anon, authenticated, service_role;

commit;
