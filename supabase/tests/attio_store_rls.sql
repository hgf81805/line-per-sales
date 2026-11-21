begin;
select set_config('line_test.owner',(select id::text from auth.users order by created_at limit 1),true);
select set_config('line_test.other',(select id::text from auth.users order by created_at offset 1 limit 1),true);
select set_config('line_test.workspace',gen_random_uuid()::text,true);
select set_config('line_test.record',gen_random_uuid()::text,true);
insert into public.line_attio_records(user_id,workspace_id,object_type,record_id,data) values
(current_setting('line_test.other')::uuid,current_setting('line_test.workspace')::uuid,'companies',current_setting('line_test.record')::uuid,'{"name":"foreign synthetic"}');
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('line_test.owner'),'role','authenticated','is_anonymous',false)::text,true);
do $$
declare n integer;
begin
 if exists(select 1 from public.line_attio_records where workspace_id=current_setting('line_test.workspace')::uuid) then raise exception 'foreign read allowed'; end if;
 insert into public.line_attio_records(user_id,workspace_id,object_type,record_id,data) values
 (auth.uid(),current_setting('line_test.workspace')::uuid,'companies',current_setting('line_test.record')::uuid,'{"name":"first"}');
 insert into public.line_attio_records(user_id,workspace_id,object_type,record_id,data) values
 (auth.uid(),current_setting('line_test.workspace')::uuid,'companies',current_setting('line_test.record')::uuid,'{"name":"updated"}')
 on conflict(user_id,workspace_id,object_type,record_id) do update set data=excluded.data;
 select count(*) into n from public.line_attio_records where workspace_id=current_setting('line_test.workspace')::uuid;
 if n<>1 then raise exception 'duplicate upsert'; end if;
 if not exists(select 1 from public.line_attio_records where workspace_id=current_setting('line_test.workspace')::uuid and data->>'name'='updated') then raise exception 'update failed'; end if;
 update public.line_attio_records set data='{"name":"forbidden"}' where user_id=current_setting('line_test.other')::uuid;
 get diagnostics n=row_count;
 if n<>0 then raise exception 'foreign update allowed'; end if;
 begin
  update public.line_attio_records set user_id=current_setting('line_test.other')::uuid where workspace_id=current_setting('line_test.workspace')::uuid;
  raise exception 'ownership transfer allowed';
 exception when insufficient_privilege then null; end;
 begin
  update public.line_attio_records set data='{"token":"forbidden"}' where workspace_id=current_setting('line_test.workspace')::uuid;
  raise exception 'unapproved field persisted';
 exception when check_violation then null; end;
end $$;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('line_test.owner'),'role','authenticated','is_anonymous',true)::text,true);
do $$ begin
 if exists(select 1 from public.line_attio_records) then raise exception 'anonymous Auth read'; end if;
 begin
  insert into public.line_attio_records(user_id,workspace_id,object_type,record_id,data) values(auth.uid(),current_setting('line_test.workspace')::uuid,'people',gen_random_uuid(),'{}');
  raise exception 'anonymous Auth write';
 exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
 begin perform 1 from public.line_attio_records; raise exception 'anon read'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'owner isolation, upsert, transfer denial, field allowlist, anonymous denial: OK' as verification;
