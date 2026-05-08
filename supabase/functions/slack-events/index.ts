import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { getWorkspaceConfig, createJob, updateJob } from '../_shared/db.ts';
import { postMessage, buildLoadingBlocks, buildHelpBlocks } from '../_shared/slack.ts';
import { parseCommand } from '../_shared/utils.ts';

serve(async (req: Request) => {
  const url = new URL(req.url);

  // Test endpoint
  if (url.searchParams.get('test') === '1') {
    return new Response(JSON.stringify({ ok: true, message: 'Function is live' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 });
  }

  const rawBody = await req.text();
  const contentType = req.headers.get('content-type') || '';

  // URL verification challenge
  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(rawBody);
      if (json.type === 'url_verification') {
        return new Response(JSON.stringify({ challenge: json.challenge }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (_e) { /* not json */ }
  }

  // Interactive payload (button clicks)
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody);
    const interactivePayload = params.get('payload');

    if (interactivePayload) {
      const data = JSON.parse(interactivePayload);
      return await handleInteractiveAction(data);
    }

    // Slash command
    const command = params.get('command');
    if (command === '/bloom-gen') {
      const teamId = params.get('team_id') || '';
      const channelId = params.get('channel_id') || '';
      const userId = params.get('user_id') || '';
      const text = params.get('text') || '';

      return await handleSlashCommand({ teamId, channelId, userId, text });
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

async function handleSlashCommand(payload: {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
}): Promise<Response> {
  const { teamId, channelId, userId, text } = payload;
  const parsed = parseCommand(text);

  // HELP
  if (parsed.action === 'help') {
    return slackResponse({ blocks: buildHelpBlocks(), response_type: 'ephemeral' });
  }

  // Get workspace config
  const config = await getWorkspaceConfig(teamId);

  // SETUP or no config
  if (parsed.action === 'setup' || !config?.bloom_api_key) {
    return slackResponse({
      response_type: 'ephemeral',
      text: '🌸 Bloom is not configured yet. Contact your workspace admin to set it up.',
    });
  }

  // BRAND
  if (parsed.action === 'brand') {
    return slackResponse({
      response_type: 'ephemeral',
      text: `*Current Brand:* ${config.brand_name || 'Unknown'}\n*Brand ID:* \`${config.brand_id}\``,
    });
  }

  // GENERATE
  if (parsed.action === 'generate') {
    if (!parsed.prompt) {
      return slackResponse({
        response_type: 'ephemeral',
        text: '❌ Please add a prompt. Example: `/bloom-gen generate summer sale hero 16:9`',
      });
    }

    // Post loading message immediately
    const loadingMsg = await postMessage(
      config.bot_token,
      channelId,
      buildLoadingBlocks(parsed.prompt, parsed.aspectRatio, userId)
    );

    // Create job
    const jobId = await createJob({
      team_id: teamId,
      channel_id: channelId,
      user_id: userId,
      prompt: parsed.prompt,
      aspect_ratio: parsed.aspectRatio,
      variants: parsed.variants,
    });

    await updateJob(jobId, { message_ts: loadingMsg.ts, status: 'generating' });

    // Fire and forget — invoke run-generation
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${supabaseUrl}/functions/v1/run-generation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobId }),
    }); // intentionally not awaited

    return new Response('', { status: 200 });
  }

  return new Response('', { status: 200 });
}

async function handleInteractiveAction(data: any): Promise<Response> {
  const action = data.actions?.[0];
  if (!action) return new Response('OK', { status: 200 });

  const actionId = action.action_id;
  const value = JSON.parse(action.value || '{}');
  const teamId = data.team?.id;

  const { getJob, updateJob } = await import('../_shared/db.ts');
  const { buildResultBlocks } = await import('../_shared/slack.ts');
  const { slackApi } = await import('../_shared/slack.ts');

  const config = await getWorkspaceConfig(teamId);
  const job = await getJob(value.jobId);
  if (!config || !job) return new Response('OK', { status: 200 });

  if (actionId === 'bloom_prev_image' || actionId === 'bloom_next_image') {
    const newIndex = value.imageIndex;
    await updateJob(value.jobId, { current_image_index: newIndex });
    await slackApi('chat.update', config.bot_token, {
      channel: job.channel_id,
      ts: job.message_ts,
      blocks: buildResultBlocks(job.prompt, job.aspect_ratio, job.image_urls, value.jobId, newIndex, config.brand_name),
    });
  }

  if (actionId === 'bloom_regenerate') {
    const { createJob } = await import('../_shared/db.ts');
    const newJobId = await createJob({
      team_id: teamId,
      channel_id: job.channel_id,
      user_id: job.user_id,
      prompt: job.prompt,
      aspect_ratio: job.aspect_ratio,
      variants: job.variants,
    });
    await updateJob(newJobId, { message_ts: job.message_ts, status: 'generating' });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${supabaseUrl}/functions/v1/run-generation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobId: newJobId }),
    });
  }

  return new Response('', { status: 200 });
}

function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
