import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(buildErrorHTML('Installation cancelled.'), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (!code) {
    return new Response(buildErrorHTML('Missing code.'), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  try {
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('SLACK_CLIENT_ID')!,
        client_secret: Deno.env.get('SLACK_CLIENT_SECRET')!,
        code,
        redirect_uri: `${Deno.env.get('SUPABASE_URL')}/functions/v1/slack-oauth`,
      }),
    });

    const tokenData = await tokenRes.json() as { ok?: boolean; error?: string; team?: { id: string; name: string }; access_token?: string; bot_user_id?: string; authed_user?: { id?: string } };
    if (!tokenData.ok) throw new Error(tokenData.error || 'oauth_failed');

    const teamId = tokenData.team!.id;
    const teamName = tokenData.team!.name;
    const botToken = tokenData.access_token!;
    const botUserId = tokenData.bot_user_id!;
    const installedBy = tokenData.authed_user?.id;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: existing } = await supabase
      .from('workspace_configs')
      .select('bloom_api_key, setup_completed, brand_id, brand_name, brand_session_id')
      .eq('team_id', teamId)
      .maybeSingle();

    const ex = existing as {
      bloom_api_key?: string;
      setup_completed?: boolean;
      brand_id?: string;
      brand_name?: string;
      brand_session_id?: string;
    } | null;

    const setupToken = crypto.randomUUID();

    await supabase.from('workspace_configs').upsert({
      team_id: teamId,
      team_name: teamName,
      bot_token: botToken,
      bot_user_id: botUserId,
      installed_by: installedBy,
      bloom_api_key: ex?.bloom_api_key || '',
      brand_id: ex?.brand_id || '',
      brand_name: ex?.brand_name || '',
      brand_session_id: ex?.brand_session_id || '',
      setup_completed: ex?.setup_completed || false,
      setup_token: setupToken,
    }, { onConflict: 'team_id' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const setupUrl = `${supabaseUrl}/functions/v1/slack-setup?token=${setupToken}`;

    if (installedBy) {
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
        const isReinstall = ex?.setup_completed;
        const message = isReinstall
          ? `🌸 *Bloom reinstalled!* Your brand config is still active. You can update your brand anytime: ${setupUrl}`
          : `🌸 *Welcome to Bloom!*\n\nYou're one step away from generating on-brand images in Slack.\n\n*Set up your brand here:*\n${setupUrl}\n\nTakes 2 minutes. You'll need your Bloom API key from trybloom.ai/developers`;

        await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: dmData.channel.id,
            text: message,
          }),
        });
      }
    }

    return new Response(buildSuccessHTML(setupUrl, teamName), {
      headers: { 'Content-Type': 'text/html' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(buildErrorHTML(message), {
      headers: { 'Content-Type': 'text/html' },
    });
  }
});

function buildSuccessHTML(setupUrl: string, teamName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Bloom Installed</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, system-ui, sans-serif; background: #0a0a0a; color: #fff; 
           display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #111; border: 1px solid #1f1f1f; border-radius: 16px; padding: 48px; 
            max-width: 480px; width: 100%; text-align: center; }
    .emoji { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p { color: #888; font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
    .btn { display: inline-block; background: #FF4500; color: white; text-decoration: none;
           border-radius: 8px; padding: 12px 24px; font-size: 14px; font-weight: 600; }
    .btn:hover { background: #e03d00; }
    .note { font-size: 12px; color: #555; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">🌸</div>
    <h1>Bloom installed for ${escapeHtml(teamName)}!</h1>
    <p>Check your Slack DMs for a setup link, or click below to configure your brand now.</p>
    <a href="${escapeHtml(setupUrl)}" class="btn">Set up your brand →</a>
    <p class="note">You'll need your Bloom API key from trybloom.ai/developers</p>
  </div>
</body>
</html>`;
}

function buildErrorHTML(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Error</title>
<style>
  body { font-family: Inter, system-ui; background: #0a0a0a; color: #fff; 
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #111; border: 1px solid #ef4444; border-radius: 16px; 
          padding: 48px; max-width: 400px; text-align: center; }
  h1 { color: #ef4444; margin-bottom: 12px; }
  p { color: #888; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>❌ Installation failed</h1>
    <p>${escapeHtml(message)}</p>
    <p style="margin-top:16px">Try installing again or contact support.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
