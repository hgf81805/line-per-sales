create table public.line_push_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_key text not null,
  private_key text not null
);
create table public.line_push_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  primary key(user_id,endpoint)
);
create table public.line_push_delivery (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id text not null,
  created_at timestamptz not null default now(),
  primary key(user_id,event_id)
);
alter table public.line_push_keys enable row level security;
alter table public.line_push_devices enable row level security;
alter table public.line_push_delivery enable row level security;
revoke all on public.line_push_keys,public.line_push_devices,public.line_push_delivery from public,anon,authenticated;
grant select,insert,update,delete on public.line_push_keys,public.line_push_devices,public.line_push_delivery to service_role;
