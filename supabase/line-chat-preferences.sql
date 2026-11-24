create table public.line_chat_preferences (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chat_id text not null check (char_length(chat_id) between 1 and 256),
  kind text not null check (kind in ('pin','hide')),
  active boolean not null,
  title text not null default '' check (char_length(title)<=200),
  primary key (user_id,kind,chat_id)
);
alter table public.line_chat_preferences enable row level security;
revoke all on public.line_chat_preferences from public,anon,authenticated;
grant select,insert,update on public.line_chat_preferences to authenticated;
create policy line_chat_preferences_owner on public.line_chat_preferences
for all to authenticated
using (user_id=(select auth.uid()) and not coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false))
with check (user_id=(select auth.uid()) and not coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false));
