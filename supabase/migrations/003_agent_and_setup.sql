-- Agent, OAuth setup, and conversation persistence

alter table workspace_configs
  add column if not exists setup_completed boolean default false,
  add column if not exists setup_token text unique,
  add column if not exists bot_user_id text,
  add column if not exists installed_by text;

create table if not exists agent_conversations (
  id uuid default gen_random_uuid() primary key,
  team_id text not null,
  channel_id text not null,
  thread_ts text not null,
  user_id text not null,
  campaign_context jsonb default '{}',
  last_active_at timestamptz default now(),
  created_at timestamptz default now(),
  unique(team_id, channel_id, thread_ts)
);

create table if not exists agent_messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references agent_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  image_urls text[] default '{}',
  created_at timestamptz default now()
);

alter table agent_conversations enable row level security;
alter table agent_messages enable row level security;

create policy "Service role access" on agent_conversations for all using (true);
create policy "Service role access" on agent_messages for all using (true);
