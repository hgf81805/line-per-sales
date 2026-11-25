alter table public.line_chat_preferences
  drop constraint line_chat_preferences_kind_check,
  drop constraint line_chat_later_fields,
  add constraint line_chat_preferences_kind_check check (kind in ('pin','hide','later','lead')),
  add constraint line_chat_later_fields check (
    (kind='later' and deferred_at is not null)
    or (kind in ('pin','hide','lead') and deferred_at is null and return_on is null)
  );
