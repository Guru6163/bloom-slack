import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

export interface WorkspaceConfig {
  team_id: string;
  team_name?: string;
  bloom_api_key: string;
  brand_id: string;
  brand_name?: string;
  brand_session_id?: string;
  bot_token: string;
}

export async function getWorkspaceConfig(teamId: string): Promise<WorkspaceConfig | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('workspace_configs')
    .select('*')
    .eq('team_id', teamId)
    .single();
  if (error || !data) return null;
  return data as WorkspaceConfig;
}

export async function saveWorkspaceConfig(
  config: Partial<WorkspaceConfig> & { team_id: string },
): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('workspace_configs')
    .upsert({ ...config, updated_at: new Date().toISOString() }, { onConflict: 'team_id' });
}

export async function createJob(job: {
  team_id: string;
  channel_id: string;
  user_id: string;
  prompt: string;
  aspect_ratio: string;
  variants: number;
}): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('generation_jobs')
    .insert(job)
    .select('id')
    .single();
  if (error || !data) throw new Error('Failed to create job');
  return data.id as string;
}

export async function updateJob(jobId: string, updates: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('generation_jobs').update(updates).eq('id', jobId);
}

export async function getJob(jobId: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('generation_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  return data;
}
