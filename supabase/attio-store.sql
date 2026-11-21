create table public.line_attio_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  object_type text not null check (object_type in ('deals','companies','people')),
  record_id uuid not null,
  data jsonb not null check (
    jsonb_typeof(data)='object' and octet_length(data::text)<=16384
    and data - array['name','detail','job_title','url','stage_id','stage','stage_since','owner_id','value','currency']::text[] = '{}'::jsonb
  ),
  fetched_at timestamptz not null default now(),
  primary key (user_id,workspace_id,object_type,record_id)
);
alter table public.line_attio_records enable row level security;
revoke all on public.line_attio_records from public,anon,authenticated;
grant select,insert,update,delete on public.line_attio_records to authenticated;
create policy line_attio_owner on public.line_attio_records for all to authenticated
using (user_id=(select auth.uid()) and not coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false))
with check (user_id=(select auth.uid()) and not coalesce((select (auth.jwt()->>'is_anonymous')::boolean),false));
comment on table public.line_attio_records is 'Latest displayed Attio record per owner/workspace/type. Persistent until explicitly deleted; not the transient job cache.';
