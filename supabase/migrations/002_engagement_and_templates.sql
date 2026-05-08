alter table generation_jobs
  add column if not exists brand_id text,
  add column if not exists source_image_id text,
  add column if not exists intent text;

create table if not exists prompt_templates (
  id uuid default gen_random_uuid() primary key,
  team_id text not null,
  brand_id text not null,
  prompt text not null,
  aspect_ratio text not null default '16:9',
  variants integer not null default 2,
  usage_count integer not null default 0,
  win_count integer not null default 0,
  last_used_at timestamptz default now(),
  last_won_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (team_id, brand_id, prompt, aspect_ratio, variants)
);

create table if not exists image_feedback (
  id uuid default gen_random_uuid() primary key,
  team_id text not null,
  brand_id text not null,
  job_id uuid references generation_jobs(id) on delete cascade,
  image_index integer not null default 0,
  user_id text not null,
  score integer not null check (score in (-1, 1)),
  created_at timestamptz default now(),
  unique (job_id, image_index, user_id)
);

create table if not exists variant_feedback_stats (
  id uuid default gen_random_uuid() primary key,
  team_id text not null,
  brand_id text not null,
  image_index integer not null default 0,
  score_sum integer not null default 0,
  vote_count integer not null default 0,
  updated_at timestamptz default now(),
  unique (team_id, brand_id, image_index)
);

alter table prompt_templates enable row level security;
alter table image_feedback enable row level security;
alter table variant_feedback_stats enable row level security;

create policy "Service role access" on prompt_templates
  for all using (true);

create policy "Service role access" on image_feedback
  for all using (true);

create policy "Service role access" on variant_feedback_stats
  for all using (true);
