import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from './supabase-admin';

export interface WorkspaceConfig {
  team_id: string;
  team_name?: string;
  bloom_api_key: string;
  brand_id: string;
  brand_name?: string;
  brand_session_id?: string;
  bot_token: string;
  setup_completed?: boolean;
  setup_token?: string | null;
  bot_user_id?: string | null;
  installed_by?: string | null;
}

export interface PromptTemplate {
  prompt: string;
  aspect_ratio: string;
  variants: number;
  usage_count: number;
  win_count: number;
}

export async function getWorkspaceConfig(teamId: string): Promise<WorkspaceConfig | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from('workspace_configs')
    .select('*')
    .eq('team_id', teamId)
    .maybeSingle();
  if (error) {
    console.warn(`[getWorkspaceConfig] team_id=${teamId}:`, error.message, error.code ?? '');
    return null;
  }
  if (!data) return null;
  return data as WorkspaceConfig;
}

export async function saveWorkspaceConfig(
  config: Partial<WorkspaceConfig> & { team_id: string },
): Promise<void> {
  const supabase = createSupabaseAdmin();
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
  thread_ts?: string | null;
}): Promise<string> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from('generation_jobs')
    .insert(job)
    .select('id')
    .single();
  if (error || !data) throw new Error('Failed to create job');
  return data.id as string;
}

export async function updateJob(jobId: string, updates: Record<string, unknown>): Promise<void> {
  const supabase = createSupabaseAdmin();
  await supabase.from('generation_jobs').update(updates).eq('id', jobId);
}

export async function getJob(jobId: string) {
  const supabase = createSupabaseAdmin();
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
  const supabase = createSupabaseAdmin();
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
  const supabase = createSupabaseAdmin();
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
  const supabase = createSupabaseAdmin();
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
  const supabase = createSupabaseAdmin();
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

export async function getOrCreateConversation(
  supabase: SupabaseClient,
  teamId: string,
  channelId: string,
  threadTs: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const { data: existing } = await supabase
    .from('agent_conversations')
    .select('*')
    .eq('team_id', teamId)
    .eq('channel_id', channelId)
    .eq('thread_ts', threadTs)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('agent_conversations')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', (existing as { id: string }).id);
    return existing as Record<string, unknown>;
  }

  const { data: created, error } = await supabase
    .from('agent_conversations')
    .insert({ team_id: teamId, channel_id: channelId, thread_ts: threadTs, user_id: userId })
    .select()
    .single();

  if (error || !created) throw new Error(error?.message || 'Failed to create conversation');
  return created as Record<string, unknown>;
}

export async function getConversationByThread(
  supabase: SupabaseClient,
  teamId: string,
  channelId: string,
  threadTs: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('agent_conversations')
    .select('*')
    .eq('team_id', teamId)
    .eq('channel_id', channelId)
    .eq('thread_ts', threadTs)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function getConversationMessages(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ role: string; content: string }[]> {
  const { data } = await supabase
    .from('agent_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20);
  return (data ?? []) as { role: string; content: string }[];
}

export async function saveMessage(
  supabase: SupabaseClient,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  imageUrls: string[] = [],
): Promise<void> {
  await supabase.from('agent_messages').insert({
    conversation_id: conversationId,
    role,
    content,
    image_urls: imageUrls,
  });
}

export async function updateCampaignContext(
  supabase: SupabaseClient,
  conversationId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from('agent_conversations')
    .update({ campaign_context: context, last_active_at: new Date().toISOString() })
    .eq('id', conversationId);
}

export async function generateSetupToken(
  supabase: SupabaseClient,
  teamId: string,
): Promise<string> {
  const token = crypto.randomUUID();
  const { data: row } = await supabase
    .from('workspace_configs')
    .select('team_id')
    .eq('team_id', teamId)
    .maybeSingle();

  if (row) {
    await supabase
      .from('workspace_configs')
      .update({ setup_token: token })
      .eq('team_id', teamId);
  } else {
    await supabase.from('workspace_configs').insert({
      team_id: teamId,
      setup_token: token,
      bloom_api_key: '',
      brand_id: '',
      bot_token: '',
      setup_completed: false,
    });
  }
  return token;
}

export async function getWorkspaceBySetupToken(
  supabase: SupabaseClient,
  token: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('workspace_configs')
    .select('*')
    .eq('setup_token', token)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

export async function updateWorkspaceBrand(
  supabase: SupabaseClient,
  teamId: string,
  brandId: string,
  brandName: string,
  brandSessionId: string,
): Promise<void> {
  await supabase
    .from('workspace_configs')
    .update({
      brand_id: brandId,
      brand_name: brandName,
      brand_session_id: brandSessionId,
      setup_completed: true,
      updated_at: new Date().toISOString(),
    })
    .eq('team_id', teamId);
}

export async function completeSetup(
  supabase: SupabaseClient,
  teamId: string,
  bloomApiKey: string,
  brandId: string,
  brandName: string,
  brandSessionId: string,
): Promise<void> {
  await supabase
    .from('workspace_configs')
    .update({
      bloom_api_key: bloomApiKey,
      brand_id: brandId,
      brand_name: brandName,
      brand_session_id: brandSessionId,
      setup_completed: true,
      updated_at: new Date().toISOString(),
    })
    .eq('team_id', teamId);
}
