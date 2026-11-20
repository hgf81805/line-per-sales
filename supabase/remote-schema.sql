-- Additive schema; existing applications and Auth configuration are unchanged.
create table public.line_remote_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Mac' check (length(name) between 1 and 100),
  last_seen timestamptz not null default now(),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create table public.line_remote_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  action text not null check (action in ('chats','conversation','suggest')),
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  status text not null default 'pending' check (status in ('pending','processing','done','error')),
  claim_id uuid,
  result jsonb check (octet_length(result::text) <= 200000),
  created_at timestamptz not null default now(),
  deadline timestamptz not null default (now() + interval '4 minutes'),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  foreign key (device_id, user_id) references public.line_remote_devices(id,user_id) on delete cascade
);
create index line_remote_devices_owner on public.line_remote_devices(user_id);
create index line_remote_jobs_queue on public.line_remote_jobs(device_id,created_at) where status = 'pending';
create index line_remote_jobs_owner on public.line_remote_jobs(user_id);
create index line_remote_jobs_expiry on public.line_remote_jobs(expires_at);
alter table public.line_remote_devices enable row level security;
alter table public.line_remote_jobs enable row level security;
revoke all on public.line_remote_devices, public.line_remote_jobs from anon, authenticated;
grant select, insert, update, delete on public.line_remote_devices to authenticated;
grant select, update, delete on public.line_remote_jobs to authenticated;
grant insert (user_id,device_id,action,payload) on public.line_remote_jobs to authenticated;
create policy line_devices_owner on public.line_remote_devices for all to authenticated
using ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false)
with check ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false);
create policy line_jobs_read on public.line_remote_jobs for select to authenticated
using ((select auth.uid()) = user_id and expires_at > now() and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false);
create policy line_jobs_create on public.line_remote_jobs for insert to authenticated
with check ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false
 and exists (select 1 from public.line_remote_devices d where d.id = device_id and d.user_id = (select auth.uid()) and d.enabled and d.last_seen > now() - interval '60 seconds'));
create policy line_jobs_update on public.line_remote_jobs for update to authenticated
using ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false)
with check ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false);
create policy line_jobs_delete on public.line_remote_jobs for delete to authenticated
using ((select auth.uid()) = user_id and coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false) = false);
-- Invoker functions retain ownership policies; no service-role key is used by clients.
create function public.line_claim_job(p_device_id uuid) returns setof public.line_remote_jobs
language sql security invoker set search_path = '' as $$
 update public.line_remote_jobs j set status = 'processing', claim_id = gen_random_uuid()
 where j.id = (select q.id from public.line_remote_jobs q
   join public.line_remote_devices d on d.id = q.device_id
   where q.device_id = p_device_id and q.user_id = (select auth.uid())
   and d.enabled and q.status = 'pending' and q.deadline > now()
   order by q.created_at for update of q skip locked limit 1)
 returning j.*;
$$;
create function public.line_finish_job(p_job_id uuid, p_claim_id uuid, p_result jsonb, p_error boolean default false)
returns void language sql security invoker set search_path = '' as $$
 update public.line_remote_jobs set status = case when p_error then 'error' else 'done' end, result = p_result
 where id = p_job_id and claim_id = p_claim_id and user_id = (select auth.uid())
 and status = 'processing' and deadline > now();
$$;
revoke all on function public.line_claim_job(uuid) from public, anon;
revoke all on function public.line_finish_job(uuid,uuid,jsonb,boolean) from public, anon;
grant execute on function public.line_claim_job(uuid) to authenticated;
grant execute on function public.line_finish_job(uuid,uuid,jsonb,boolean) to authenticated;
-- Transient responses are removed even while the Mac is offline.
create extension if not exists pg_cron;
select cron.schedule('line-remote-expired-jobs', '* * * * *',
  $cleanup$delete from public.line_remote_jobs where expires_at < now()$cleanup$);
