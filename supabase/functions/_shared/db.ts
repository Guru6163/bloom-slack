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

export interface PromptTemplate {
  prompt: string;
  aspect_ratio: string;
  variants: number;
  usage_count: number;
  win_count: number;
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
  brand_id?: string;
  source_image_id?: string;
  intent?: string;
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

export async function upsertPromptTemplate(params: {
  team_id: string;
  brand_id: string;
  prompt: string;
  aspect_ratio: string;
  variants: number;
  won?: boolean;
}): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('prompt_templates')
    .select('id, usage_count, win_count')
    .eq('team_id', params.team_id)
    .eq('brand_id', params.brand_id)
    .eq('prompt', params.prompt)
    .eq('aspect_ratio', params.aspect_ratio)
    .eq('variants', params.variants)
    .maybeSingle();

  const usage = Number(data?.usage_count ?? 0) + 1;
  const wins = Number(data?.win_count ?? 0) + (params.won ? 1 : 0);
  await supabase.from('prompt_templates').upsert({
    team_id: params.team_id,
    brand_id: params.brand_id,
    prompt: params.prompt,
    aspect_ratio: params.aspect_ratio,
    variants: params.variants,
    usage_count: usage,
    win_count: wins,
    last_used_at: new Date().toISOString(),
    ...(params.won ? { last_won_at: new Date().toISOString() } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'team_id,brand_id,prompt,aspect_ratio,variants' });
}

export async function listTopPromptTemplates(
  teamId: string,
  brandId: string,
  limit = 3,
): Promise<PromptTemplate[]> {
  const supabase = getSupabase();
  const safeLimit = Math.max(1, Math.min(5, limit));
  const { data } = await supabase
    .from('prompt_templates')
    .select('prompt, aspect_ratio, variants, usage_count, win_count')
    .eq('team_id', teamId)
    .eq('brand_id', brandId)
    .order('win_count', { ascending: false })
    .order('usage_count', { ascending: false })
    .limit(safeLimit);
  return (data ?? []) as PromptTemplate[];
}

export async function recordImageFeedback(params: {
  team_id: string;
  brand_id: string;
  job_id: string;
  image_index: number;
  user_id: string;
  score: -1 | 1;
}): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('image_feedback').upsert({
    team_id: params.team_id,
    brand_id: params.brand_id,
    job_id: params.job_id,
    image_index: params.image_index,
    user_id: params.user_id,
    score: params.score,
  }, { onConflict: 'job_id,image_index,user_id' });

  const { data } = await supabase
    .from('variant_feedback_stats')
    .select('id, score_sum, vote_count')
    .eq('team_id', params.team_id)
    .eq('brand_id', params.brand_id)
    .eq('image_index', params.image_index)
    .maybeSingle();

  await supabase.from('variant_feedback_stats').upsert({
    team_id: params.team_id,
    brand_id: params.brand_id,
    image_index: params.image_index,
    score_sum: Number(data?.score_sum ?? 0) + params.score,
    vote_count: Number(data?.vote_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'team_id,brand_id,image_index' });
}

export async function getVariantPositionBias(
  teamId: string,
  brandId: string,
): Promise<Map<number, number>> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('variant_feedback_stats')
    .select('image_index, score_sum, vote_count')
    .eq('team_id', teamId)
    .eq('brand_id', brandId)
    .limit(20);

  const bias = new Map<number, number>();
  for (const row of data ?? []) {
    const idx = Number((row as Record<string, unknown>).image_index ?? -1);
    const score = Number((row as Record<string, unknown>).score_sum ?? 0);
    const votes = Number((row as Record<string, unknown>).vote_count ?? 0);
    if (idx >= 0 && votes > 0) {
      bias.set(idx, score / votes);
    }
  }
  return bias;
}
