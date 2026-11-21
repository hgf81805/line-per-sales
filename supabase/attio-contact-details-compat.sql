create function public.line_keep_attio_contact_details()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Older connectors replace the JSON without sending any of the new fields.
  if old.object_type = 'people' and new.object_type = 'people'
     and not (new.data ?| array['emails','phones','description','created_at'])
     and old.data ? 'created_at' then
    new.data := new.data || jsonb_build_object(
      'emails', old.data->'emails',
      'phones', old.data->'phones',
      'description', old.data->'description',
      'created_at', old.data->'created_at'
    );
  end if;
  return new;
end;
$$;
revoke execute on function public.line_keep_attio_contact_details() from public, anon, authenticated;
create trigger line_keep_attio_contact_details
before update of data on public.line_attio_records
for each row execute function public.line_keep_attio_contact_details();
