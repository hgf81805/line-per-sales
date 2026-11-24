alter table public.line_chat_preferences
  drop constraint line_chat_preferences_kind_check,
  add constraint line_chat_preferences_kind_check check (kind in ('pin','hide','later')),
  add column deferred_at timestamptz,
  add column return_on date,
  add constraint line_chat_later_fields check (
    (kind='later' and deferred_at is not null)
    or (kind in ('pin','hide') and deferred_at is null and return_on is null)
  );

create function public.line_restore_later(p_rows jsonb)
returns void
language sql
set search_path = ''
as $$
  update public.line_chat_preferences as pref
  set active=false
  from jsonb_to_recordset(p_rows) as released(chat_id text,deferred_at timestamptz)
  where pref.user_id=(select auth.uid())
    and pref.kind='later' and pref.active
    and pref.chat_id=released.chat_id and pref.deferred_at=released.deferred_at;
$$;
revoke execute on function public.line_restore_later(jsonb) from public, anon;
grant execute on function public.line_restore_later(jsonb) to authenticated;
