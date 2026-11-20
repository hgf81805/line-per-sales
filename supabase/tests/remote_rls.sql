begin;
-- Use two existing user identifiers inside a rolled-back transaction. No user data is returned.
select set_config('line_test.owner', (select id::text from auth.users order by created_at limit 1), true);
select set_config('line_test.other', (select id::text from auth.users order by created_at offset 1 limit 1), true);
select set_config('line_test.device', gen_random_uuid()::text, true);
select set_config('line_test.other_device', gen_random_uuid()::text, true);
insert into public.line_remote_devices(id,user_id,name) values
 (current_setting('line_test.device')::uuid,current_setting('line_test.owner')::uuid,'Test owner Mac'),
 (current_setting('line_test.other_device')::uuid,current_setting('line_test.other')::uuid,'Test other Mac');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub',current_setting('line_test.owner'),'role','authenticated','is_anonymous',false)::text, true);
do $$
declare n integer; job public.line_remote_jobs;
begin
 select count(*) into n from public.line_remote_devices where id in (current_setting('line_test.device')::uuid,current_setting('line_test.other_device')::uuid);
 if n <> 1 then raise exception 'RLS leaked devices'; end if;
 update public.line_remote_devices set name='Must not update' where id=current_setting('line_test.other_device')::uuid;
 get diagnostics n = row_count;
 if n <> 0 then raise exception 'RLS allowed foreign update'; end if;
 begin
  insert into public.line_remote_jobs(user_id,device_id,action,payload) values
    (current_setting('line_test.owner')::uuid,current_setting('line_test.other_device')::uuid,'chats','{}');
  raise exception 'RLS allowed foreign device job';
 exception when insufficient_privilege then null; end;
 insert into public.line_remote_jobs(user_id,device_id,action,payload) values
  (current_setting('line_test.owner')::uuid,current_setting('line_test.device')::uuid,'chats','{}');
 select * into job from public.line_claim_job(current_setting('line_test.device')::uuid);
 if job.id is null or job.status <> 'processing' or job.claim_id is null then raise exception 'claim failed'; end if;
 perform public.line_finish_job(job.id,gen_random_uuid(),'{"chats":[]}',false);
 if exists (select 1 from public.line_remote_jobs where id=job.id and status='done') then raise exception 'wrong claim accepted'; end if;
 perform public.line_finish_job(job.id,job.claim_id,'{"chats":[]}',false);
 if not exists (select 1 from public.line_remote_jobs where id=job.id and status='done') then raise exception 'finish failed'; end if;
 update public.line_remote_devices set last_seen=now()-interval '2 minutes' where id=current_setting('line_test.device')::uuid;
 begin
  insert into public.line_remote_jobs(user_id,device_id,action,payload) values
    (current_setting('line_test.owner')::uuid,current_setting('line_test.device')::uuid,'chats','{}');
  raise exception 'offline device accepted';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims', json_build_object('sub',current_setting('line_test.owner'),'role','authenticated','is_anonymous',true)::text, true);
do $$ begin
 if exists (select 1 from public.line_remote_devices) then raise exception 'anonymous auth saw devices'; end if;
 if exists (select 1 from public.line_remote_jobs) then raise exception 'anonymous auth saw jobs'; end if;
end $$;
set local role anon;
do $$ begin
 begin perform 1 from public.line_remote_devices; raise exception 'anon has table access'; exception when insufficient_privilege then null; end;
 begin perform public.line_claim_job(current_setting('line_test.device')::uuid); raise exception 'anon has RPC access'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'ownership, anonymous denial, claim nonce, offline rejection: OK' as verification;
