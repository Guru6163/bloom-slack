import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { getWorkspaceConfig, createJob, saveWorkspaceConfig, updateJob } from '../_shared/db.ts';
import {
  getBrand,
  getCredits,
  getImage,
  getImageUrl,
  listBrands,
  listImages,
  listWorkspaces,
  resolveBrandSessionId,
  validateKey,
} from '../_shared/bloom.ts';
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
  const config = await getWorkspaceConfig(teamId);

  // HELP
  if (parsed.action === 'help') {
    return slackResponse({ blocks: buildHelpBlocks(), response_type: 'ephemeral' });
  }

  // SETUP
  if (parsed.action === 'setup') {
    const apiKey = parsed.setupApiKey || '';
    const requestedBrandId = parsed.setupBrandId || '';

    if (!apiKey) {
      return slackResponse({
        response_type: 'ephemeral',
        text:
          'To connect Bloom for this workspace, run:\n' +
          '`/bloom-gen setup <bloom_api_key> [brand_id]`\n\n' +
          'If `brand_id` is omitted, the first brand from your Bloom account is used.',
      });
    }

    const isValid = await validateKey(apiKey);
    if (!isValid) {
      return slackResponse({
        response_type: 'ephemeral',
        text: '❌ Invalid Bloom API key. Please verify the key and try again.',
      });
    }

    let selectedBrand: Record<string, unknown> | null = null;
    if (requestedBrandId) {
      try {
        const brandResponse = await getBrand(apiKey, requestedBrandId);
        selectedBrand = brandResponse && typeof brandResponse === 'object'
          ? brandResponse as Record<string, unknown>
          : null;
      } catch {
        selectedBrand = null;
      }
      if (!selectedBrand) {
        return slackResponse({
          response_type: 'ephemeral',
          text: `❌ Brand not found for ID \`${requestedBrandId}\`. Try without a brand ID to use your default brand.`,
        });
      }
    } else {
      const brands = await listBrands(apiKey);
      selectedBrand = brands.find((item) => !!item && typeof item === 'object') as Record<string, unknown> | undefined || null;
      if (!selectedBrand) {
        return slackResponse({
          response_type: 'ephemeral',
          text: '❌ No brands found in this Bloom account. Please create a brand in Bloom first.',
        });
      }
    }

    const brandId = String(
      selectedBrand.id ??
      selectedBrand.brandId ??
      selectedBrand.brand_id ??
      requestedBrandId ??
      '',
    );
    const brandName = String(selectedBrand.name ?? selectedBrand.brandName ?? selectedBrand.brand_name ?? '');
    const brandSessionId = resolveBrandSessionId(selectedBrand);

    if (!brandId) {
      return slackResponse({
        response_type: 'ephemeral',
        text: '❌ Could not resolve a usable brand ID from Bloom. Please try another brand.',
      });
    }

    await saveWorkspaceConfig({
      team_id: teamId,
      bloom_api_key: apiKey,
      brand_id: brandId,
      ...(brandName ? { brand_name: brandName } : {}),
      ...(brandSessionId ? { brand_session_id: brandSessionId } : {}),
    });

    return slackResponse({
      response_type: 'ephemeral',
      text:
        '✅ Bloom connected for this workspace.\n' +
        `*Brand:* ${brandName || 'Unknown'}\n` +
        `*Brand ID:* \`${brandId}\`\n\n` +
        'You can now run `/bloom-gen generate <prompt> [ratio]`.',
    });
  }

  // No setup yet
  if (!config?.bloom_api_key) {
    return slackResponse({
      response_type: 'ephemeral',
      text:
        '🌸 Bloom is not configured for this workspace.\n' +
        'Run `/bloom-gen setup <bloom_api_key> [brand_id]` to connect your workspace-specific Bloom account.',
    });
  }

  // BRAND
  if (parsed.action === 'brand') {
    if (parsed.entityId) {
      try {
        const brandResponse = await getBrand(config.bloom_api_key, parsed.entityId);
        const brand = brandResponse && typeof brandResponse === 'object'
          ? brandResponse as Record<string, unknown>
          : null;
        if (!brand) throw new Error('Brand not found');
        const brandId = String(brand.id ?? brand.brandId ?? brand.brand_id ?? parsed.entityId);
        const brandName = String(brand.name ?? brand.brandName ?? brand.brand_name ?? 'Unknown');
        const brandSessionId = resolveBrandSessionId(brand);
        return slackResponse({
          response_type: 'ephemeral',
          text:
            `*Brand:* ${brandName}\n` +
            `*Brand ID:* \`${brandId}\`\n` +
            `*Session ID:* \`${brandSessionId || 'N/A'}\``,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unable to fetch brand';
        return slackResponse({
          response_type: 'ephemeral',
          text: `❌ ${message}`,
        });
      }
    }

    return slackResponse({
      response_type: 'ephemeral',
      text: `*Current Brand:* ${config.brand_name || 'Unknown'}\n*Brand ID:* \`${config.brand_id}\``,
    });
  }

  // BRANDS
  if (parsed.action === 'brands') {
    try {
      const brands = await listBrands(config.bloom_api_key);
      const lines = brands
        .filter((item) => !!item && typeof item === 'object')
        .slice(0, 20)
        .map((item) => {
          const brand = item as Record<string, unknown>;
          const id = String(brand.id ?? brand.brandId ?? brand.brand_id ?? '');
          const name = String(brand.name ?? brand.brandName ?? brand.brand_name ?? 'Unknown');
          return `• ${name} (\`${id || 'N/A'}\`)`;
        });
      return slackResponse({
        response_type: 'ephemeral',
        text: lines.length
          ? `*Available Bloom Brands (${lines.length})*\n${lines.join('\n')}`
          : 'No brands found in your Bloom account.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to list brands';
      return slackResponse({
        response_type: 'ephemeral',
        text: `❌ ${message}`,
      });
    }
  }

  // IMAGES
  if (parsed.action === 'images') {
    try {
      const images = await listImages(config.bloom_api_key, parsed.limit ?? 10);
      const lines = images
        .filter((item) => !!item && typeof item === 'object')
        .slice(0, 25)
        .map((item) => formatImageSummary(item as Record<string, unknown>));
      return slackResponse({
        response_type: 'ephemeral',
        text: lines.length
          ? `*Recent Bloom Images (${lines.length})*\n${lines.join('\n')}`
          : 'No images found in your Bloom account.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to list images';
      return slackResponse({
        response_type: 'ephemeral',
        text: `❌ ${message}`,
      });
    }
  }

  // IMAGE
  if (parsed.action === 'image') {
    if (!parsed.entityId) {
      return slackResponse({
        response_type: 'ephemeral',
        text: 'Usage: `/bloom-gen image <image_id>`',
      });
    }

    try {
      const image = await getImage(config.bloom_api_key, parsed.entityId);
      if (!image || typeof image !== 'object') {
        return slackResponse({
          response_type: 'ephemeral',
          text: `Image not found for ID \`${parsed.entityId}\`.`,
        });
      }
      const img = image as Record<string, unknown>;
      const url = getImageUrl(img);
      const id = String(img.id ?? img.imageId ?? parsed.entityId);
      const status = String(img.status ?? 'unknown');
      const prompt = String(img.prompt ?? img.originalPrompt ?? '').trim();
      return slackResponse({
        response_type: 'ephemeral',
        text:
          `*Image ID:* \`${id}\`\n` +
          `*Status:* ${status}\n` +
          `${prompt ? `*Prompt:* ${prompt}\n` : ''}` +
          `${url ? `*URL:* ${url}` : '*URL:* Not available yet'}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to fetch image';
      return slackResponse({
        response_type: 'ephemeral',
        text: `❌ ${message}`,
      });
    }
  }

  // CREDITS
  if (parsed.action === 'credits') {
    try {
      const credits = await getCredits(config.bloom_api_key);
      return slackResponse({
        response_type: 'ephemeral',
        text:
          '*Bloom Credits*\n' +
          `Balance: ${credits.balance ?? 'N/A'}\n` +
          `Unlimited: ${credits.unlimited === null ? 'N/A' : credits.unlimited ? 'Yes' : 'No'}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to fetch credits';
      return slackResponse({
        response_type: 'ephemeral',
        text: `❌ ${message}`,
      });
    }
  }

  // WORKSPACES
  if (parsed.action === 'workspaces') {
    try {
      const workspaces = await listWorkspaces(config.bloom_api_key);
      const lines = workspaces
        .filter((item) => !!item && typeof item === 'object')
        .slice(0, 30)
        .map((item) => {
          const workspace = item as Record<string, unknown>;
          const id = String(workspace.id ?? 'personal');
          const name = String(workspace.name ?? 'Personal');
          return `• ${name} (\`${id}\`)`;
        });
      return slackResponse({
        response_type: 'ephemeral',
        text: lines.length
          ? `*Bloom Workspaces (${lines.length})*\n${lines.join('\n')}`
          : 'No workspaces found.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to list workspaces';
      return slackResponse({
        response_type: 'ephemeral',
        text: `❌ ${message}`,
      });
    }
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

function formatImageSummary(image: Record<string, unknown>): string {
  const id = String(image.id ?? image.imageId ?? 'N/A');
  const status = String(image.status ?? 'unknown');
  const url = getImageUrl(image);
  const prompt = String(image.prompt ?? image.originalPrompt ?? '').trim();
  const clippedPrompt = prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
  return `• \`${id}\` · ${status}${clippedPrompt ? ` · ${clippedPrompt}` : ''}${url ? `\n  ${url}` : ''}`;
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
