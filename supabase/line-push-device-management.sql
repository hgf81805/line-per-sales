alter table public.line_push_devices
  add column device_id uuid not null default gen_random_uuid(),
  add column device_label text,
  add column registered_at timestamptz;

create unique index line_push_devices_owner_device_idx
  on public.line_push_devices (user_id, device_id);
