alter table public.line_attio_records drop constraint line_attio_records_data_check;
alter table public.line_attio_records add constraint line_attio_records_data_check check (
    jsonb_typeof(data)='object' and octet_length(data::text)<=16384
    and data - array['name','detail','job_title','url','stage_id','stage','stage_since','owner_id','value','currency','emails','phones','description','created_at']::text[] = '{}'::jsonb
    and (object_type='people' or not (data ?| array['emails','phones','description','created_at']))
);
