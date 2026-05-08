create table if not exists workspace_configs (
  id uuid default gen_random_uuid() primary key,
  team_id text unique not null,
  team_name text,
  bloom_api_key text not null default '',
  brand_id text not null default '',
  brand_name text,
  brand_session_id text,
  bot_token text not null default '',
  installed_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists generation_jobs (
  id uuid default gen_random_uuid() primary key,
  team_id text not null,
  channel_id text not null,
  user_id text not null,
  message_ts text,
  prompt text not null,
  aspect_ratio text default '16:9',
  variants integer default 2,
  status text default 'pending',
  image_ids text[],
  image_urls text[],
  current_image_index integer default 0,
  error text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

alter table workspace_configs enable row level security;
alter table generation_jobs enable row level security;

create policy "Service role access" on workspace_configs
  for all using (true);

create policy "Service role access" on generation_jobs
  for all using (true);
