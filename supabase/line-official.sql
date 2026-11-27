create table public.line_official_threads (
  line_user text primary key,
  display_name text,
  inbound_at timestamptz not null,
  replied_at timestamptz,
  priority boolean not null default false
);
create table public.line_official_messages (
  id text primary key,
  line_user text not null references public.line_official_threads(line_user),
  direction text not null check (direction in ('in','out')),
  body text not null,
  created_at timestamptz not null default now(),
  sent boolean not null default false
);
create index line_official_messages_thread on public.line_official_messages(line_user,created_at desc);
create index line_official_threads_recent on public.line_official_threads(inbound_at desc);
alter table public.line_official_threads enable row level security;
alter table public.line_official_messages enable row level security;
revoke all on public.line_official_threads, public.line_official_messages from public,anon,authenticated;
grant select,insert,update,delete on public.line_official_threads, public.line_official_messages to service_role;

create function public.line_official_accept_message(p_user text,p_id text,p_body text,p_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
  insert into public.line_official_threads(line_user,inbound_at) values (p_user,p_at)
  on conflict(line_user) do update set inbound_at=greatest(line_official_threads.inbound_at,excluded.inbound_at);
  insert into public.line_official_messages(id,line_user,direction,body,created_at,sent)
  values ('in:'||p_id,p_user,'in',p_body,p_at,true)
  on conflict(id) do nothing;
end;
$$;
revoke all on function public.line_official_accept_message(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.line_official_accept_message(text,text,text,timestamptz) to service_role;
