alter table public.line_official_threads add column account_id text not null default 'default';
alter table public.line_official_messages add column account_id text not null default 'default';

alter table public.line_official_messages drop constraint line_official_messages_line_user_fkey;
alter table public.line_official_threads drop constraint line_official_threads_pkey;
alter table public.line_official_threads add primary key (account_id,line_user);
alter table public.line_official_messages drop constraint line_official_messages_pkey;
alter table public.line_official_messages add primary key (account_id,id);
alter table public.line_official_messages add foreign key (account_id,line_user)
  references public.line_official_threads(account_id,line_user);

create index line_official_threads_account_recent on public.line_official_threads(account_id,priority desc,inbound_at desc);
create index line_official_messages_account_history on public.line_official_messages(account_id,line_user,created_at desc);

create function public.line_official_accept_message(p_account text,p_user text,p_id text,p_body text,p_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
begin
  insert into public.line_official_threads(account_id,line_user,inbound_at) values (p_account,p_user,p_at)
  on conflict(account_id,line_user) do update set inbound_at=greatest(line_official_threads.inbound_at,excluded.inbound_at);
  insert into public.line_official_messages(account_id,id,line_user,direction,body,created_at,sent)
  values (p_account,'in:'||p_id,p_user,'in',p_body,p_at,true)
  on conflict(account_id,id) do nothing;
end;
$$;
revoke all on function public.line_official_accept_message(text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.line_official_accept_message(text,text,text,text,timestamptz) to service_role;

create or replace function public.line_official_accept_message(p_user text,p_id text,p_body text,p_at timestamptz)
returns void language sql security invoker set search_path='' as $$
  select public.line_official_accept_message('default',p_user,p_id,p_body,p_at);
$$;
