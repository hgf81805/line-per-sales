alter table public.line_remote_jobs drop constraint line_remote_jobs_action_check;
alter table public.line_remote_jobs add constraint line_remote_jobs_action_check check (action in (
'chats','conversation','suggest','prepare-send','send','send-status',
'attio-list','attio-linked','attio-link','attio-unlink','attio-create','attio-stage','attio-task','attio-complete','attio-contact','attio-note'));

create function public.line_update_attio_note_cache(p_workspace uuid, p_person uuid, p_note jsonb)
returns boolean
language sql
set search_path = ''
as $$
  with changed as (
    update public.line_attio_records as r
    set notes = coalesce(
      (select jsonb_agg(n) from jsonb_array_elements(r.notes) n where n->>'id' is distinct from p_note->>'id'),
      '[]'::jsonb
    ) || jsonb_build_array(p_note)
    where r.user_id = (select auth.uid())
      and r.workspace_id = p_workspace and r.record_id = p_person
      and r.object_type = 'people'
    returning 1
  )
  select exists(select 1 from changed);
$$;
revoke execute on function public.line_update_attio_note_cache(uuid,uuid,jsonb) from public, anon;
grant execute on function public.line_update_attio_note_cache(uuid,uuid,jsonb) to authenticated;
