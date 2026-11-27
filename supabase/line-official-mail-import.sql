create table public.line_official_mail_import (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox text not null,
  token_hash text unique check (length(token_hash)=64),
  unique (owner_id,mailbox)
);
alter table public.line_official_mail_import enable row level security;
revoke all on public.line_official_mail_import from public,anon,authenticated;
grant select,insert,update,delete on public.line_official_mail_import to service_role;
