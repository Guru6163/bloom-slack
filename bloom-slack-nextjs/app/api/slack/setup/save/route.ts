import { createSupabaseAdmin } from '@/lib/supabase-admin';

export async function POST(req: Request) {
  const body = (await req.json()) as {
    token?: string;
    bloom_api_key?: string | null;
    brand_id?: string;
    brand_name?: string;
    brand_session_id?: string;
  };

  const supabase = createSupabaseAdmin();
  const { data: row, error } = await supabase
    .from('workspace_configs')
    .select('*')
    .eq('setup_token', body.token ?? '')
    .maybeSingle();

  if (error || !row) {
    return Response.json({ success: false, error: 'Invalid token' }, { status: 401 });
  }

  const workspace = row as Record<string, unknown>;

  const updateData: Record<string, unknown> = {
    brand_id: body.brand_id,
    brand_name: body.brand_name,
    brand_session_id: body.brand_session_id,
    setup_completed: true,
    updated_at: new Date().toISOString(),
  };

  if (body.bloom_api_key) updateData.bloom_api_key = body.bloom_api_key;

  await supabase
    .from('workspace_configs')
    .update(updateData)
    .eq('team_id', workspace.team_id as string);

  const installedBy = workspace.installed_by as string | undefined;
  const botToken = workspace.bot_token as string | undefined;
  if (installedBy && botToken) {
    const dmRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ users: installedBy }),
    });
    const dmData = await dmRes.json() as { ok?: boolean; channel?: { id: string } };
    if (dmData.ok && dmData.channel?.id) {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: dmData.channel.id,
          text: `🌸 *Bloom is ready!* Brand set to *${body.brand_name}*.\n\nMention @Bloom in any channel to start generating on-brand images.\n\nTry: "@Bloom create a summer sale banner for Instagram"`,
        }),
      });
    }
  }

  return Response.json({ success: true });
}
