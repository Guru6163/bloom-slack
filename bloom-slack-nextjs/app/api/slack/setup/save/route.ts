import { createSupabaseAdmin } from '@/lib/supabase-admin';

export async function POST(req: Request) {
  const body = (await req.json()) as {
    token?: string;
    bloom_api_key?: string | null;
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

  if (!body.bloom_api_key?.trim()) {
    return Response.json({ success: false, error: 'Bloom API key is required' }, { status: 400 });
  }

  await supabase
    .from('workspace_configs')
    .update({
      bloom_api_key: body.bloom_api_key.trim(),
      brand_id: '',
      brand_name: '',
      brand_session_id: '',
      setup_completed: true,
      updated_at: new Date().toISOString(),
    })
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
          text:
            '🌸 *Bloom is ready!* Your Slack workspace is connected.\n\n' +
            'Mention @Bloom with which brand to use (name or ID), or run ' +
            '`/bloom-gen generate … --brand <brand_uuid>`.\n\n' +
            'Try: "@Bloom for _BrandName_: hero image for LinkedIn, 16:9"',
        }),
      });
    }
  }

  return Response.json({ success: true });
}
