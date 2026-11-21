alter table public.line_attio_records add column notes jsonb
check (notes is null or (object_type='people' and jsonb_typeof(notes)='array' and octet_length(notes::text)<=120000));
