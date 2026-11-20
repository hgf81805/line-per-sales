alter table public.line_remote_jobs drop constraint line_remote_jobs_action_check;
alter table public.line_remote_jobs add constraint line_remote_jobs_action_check check (action in (
'chats','conversation','suggest','prepare-send','send','send-status',
'attio-list','attio-linked','attio-link','attio-unlink','attio-create','attio-stage','attio-task','attio-complete'));
