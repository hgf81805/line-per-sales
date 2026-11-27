alter table public.line_official_threads add column reply_url text;
create function public.line_official_accept_mail(
  p_account text,p_user text,p_id text,p_body text,p_at timestamptz,p_name text,p_reply_url text
)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform public.line_official_accept_message(p_account,p_user,p_id,p_body,p_at);
  update public.line_official_threads
  set display_name=p_name, reply_url=p_reply_url
  where account_id=p_account and line_user=p_user and inbound_at<=p_at;
end;
$$;
revoke all on function public.line_official_accept_mail(text,text,text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.line_official_accept_mail(text,text,text,text,timestamptz,text,text) to service_role;
