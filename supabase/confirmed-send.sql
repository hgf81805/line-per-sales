alter table public.line_remote_devices add column capabilities text[] not null default '{}';
alter table public.line_remote_jobs drop constraint line_remote_jobs_action_check;
alter table public.line_remote_jobs add constraint line_remote_jobs_action_check check (action in ('chats','conversation','suggest','prepare-send','send','send-status'));
alter table public.line_remote_jobs drop constraint line_remote_jobs_payload_check;
alter table public.line_remote_jobs add constraint line_remote_jobs_payload_check check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=8192);
