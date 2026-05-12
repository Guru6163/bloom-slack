import { createSupabaseAdmin } from './supabase-admin';
import {
  createJob,
  generateSetupToken,
  getConversationByThread,
  getJob,
  getWorkspaceConfig,
  recordImageFeedback,
  saveWorkspaceConfig,
  updateJob,
  upsertPromptTemplate,
} from './db';
import {
  formatSlackBrandsList,
  getBrand,
  getCredits,
  getImage,
  getImageUrl,
  listBrands,
  listImages,
  listWorkspaces,
  resolveBrandSessionId,
  validateKey,
} from './bloom';
import {
  buildHelpBlocks,
  buildLoadingBlocks,
  buildResultBlocks,
  postMessage,
  slackApi,
  updateMessage,
} from './slack';
import { parseCommand } from './utils';
import { getAppBaseUrl } from './app-url';
import { scheduleBackgroundFetch } from './schedule-background-fetch';

function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function formatImageSummary(image: Record<string, unknown>): string {
  const id = String(image.id ?? image.imageId ?? 'N/A');
  const status = String(image.status ?? 'unknown');
  const url = getImageUrl(image);
  const prompt = String(image.prompt ?? image.originalPrompt ?? '').trim();
  const clippedPrompt = prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
  return `• \`${id}\` · ${status}${clippedPrompt ? ` · ${clippedPrompt}` : ''}${url ? `\n  ${url}` : ''}`;
}

async function postCommandResponse(
  botToken: string,
  channelId: string,
  userId: string,
  rawText: string,
  responseText: string,
): Promise<Response> {
  const command = `/bloom-gen ${rawText}`.trim();
  const parent = await postMessage(botToken, channelId, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👤 <@${userId}> ran \`${command}\``,
      },
    },
  ]);

  const parentTs = String(parent.ts ?? '');
  await postMessage(
    botToken,
    channelId,
    [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: responseText },
      },
    ],
    parentTs || undefined,
  );

  return new Response('', { status: 200 });
}

async function handleSlashCommand(payload: {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  threadTs?: string;
}): Promise<Response> {
  const { teamId, channelId, userId, text, threadTs } = payload;
  const parsed = parseCommand(text);
  const config = await getWorkspaceConfig(teamId);
  const baseUrl = getAppBaseUrl();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (parsed.action === 'help') {
    return slackResponse({
      response_type: 'ephemeral',
      blocks: buildHelpBlocks(),
    });
  }

  if (parsed.action === 'setup') {
    const apiKey = parsed.setupApiKey || '';
    const requestedBrandId = parsed.setupBrandId || '';

    if (!apiKey) {
      return slackResponse({
        response_type: 'ephemeral',
        text:
          'To connect Bloom for this workspace, run:\n' +
          '`/bloom-gen setup <bloom_api_key> [brand_id]`\n\n' +
          'If `brand_id` is omitted, the first brand from your Bloom account is used.\n\n' +
          'Or use the web setup link from your install DM.',
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
      selectedBrand = brands.find((item) => !!item && typeof item === 'object') as Record<string, unknown> | undefined ||
        null;
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
      setup_completed: true,
    });

    return slackResponse({
      response_type: 'ephemeral',
      text:
        '✅ Bloom connected for this workspace.\n' +
        `*Brand:* ${brandName || 'Unknown'}\n` +
        `*Brand ID:* \`${brandId}\`\n\n` +
        'You can now run `/bloom-gen generate <prompt> [ratio]` or mention @Bloom in a channel.',
    });
  }

  if (!config?.bloom_api_key?.trim()) {
    const supabase = createSupabaseAdmin();
    const token = await generateSetupToken(supabase, teamId);
    const setupUrl = `${baseUrl}/api/slack/setup?token=${token}`;
    return slackResponse({
      response_type: 'ephemeral',
      text: `🌸 Bloom isn't configured yet.\nSet up here: ${setupUrl}`,
    });
  }

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
        return await postCommandResponse(
          config.bot_token,
          channelId,
          userId,
          text,
          `*Brand:* ${brandName}\n*Brand ID:* \`${brandId}\`\n*Session ID:* \`${brandSessionId || 'N/A'}\``,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unable to fetch brand';
        return await postCommandResponse(config.bot_token, channelId, userId, text, `❌ ${message}`);
      }
    }

    const supabase = createSupabaseAdmin();
    const token = await generateSetupToken(supabase, teamId);
    const setupUrl = `${baseUrl}/api/slack/setup?token=${token}`;
    return slackResponse({
      response_type: 'ephemeral',
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Current brand:* ${config.brand_name || 'Not set'}\n\n*Tip:* Mention @Bloom in any channel to generate images with natural language!`,
        },
      }, {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Change Brand' },
          url: setupUrl,
        }],
      }],
    });
  }

  if (parsed.action === 'brands') {
    try {
      const brands = await listBrands(config.bloom_api_key);
      const body = formatSlackBrandsList(brands, config.brand_id);
      return await postCommandResponse(
        config.bot_token,
        channelId,
        userId,
        text,
        body,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to list brands';
      return await postCommandResponse(config.bot_token, channelId, userId, text, `❌ ${message}`);
    }
  }

  if (parsed.action === 'images') {
    try {
      const images = await listImages(config.bloom_api_key, parsed.limit ?? 10);
      const lines = images
        .filter((item) => !!item && typeof item === 'object')
        .slice(0, 25)
        .map((item) => formatImageSummary(item as Record<string, unknown>));
      return await postCommandResponse(
        config.bot_token,
        channelId,
        userId,
        text,
        lines.length
          ? `*Recent Bloom Images (${lines.length})*\n${lines.join('\n')}`
          : 'No images found in your Bloom account.',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to list images';
      return await postCommandResponse(config.bot_token, channelId, userId, text, `❌ ${message}`);
    }
  }

  if (parsed.action === 'image') {
    if (!parsed.entityId) {
      return await postCommandResponse(config.bot_token, channelId, userId, text, 'Usage: `/bloom-gen image <image_id>`');
    }

    try {
      const image = await getImage(config.bloom_api_key, parsed.entityId);
      if (!image || typeof image !== 'object') {
        return await postCommandResponse(
          config.bot_token,
          channelId,
          userId,
          text,
          `Image not found for ID \`${parsed.entityId}\`.`,
        );
      }
      const img = image as Record<string, unknown>;
      const url = getImageUrl(img);
      const id = String(img.id ?? img.imageId ?? parsed.entityId);
      const status = String(img.status ?? 'unknown');
      const prompt = String(img.prompt ?? img.originalPrompt ?? '').trim();
      return await postCommandResponse(
        config.bot_token,
        channelId,
        userId,
        text,
        `*Image ID:* \`${id}\`\n*Status:* ${status}\n${prompt ? `*Prompt:* ${prompt}\n` : ''}${url ? `*URL:* ${url}` : '*URL:* Not available yet'}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to fetch image';
      return await postCommandResponse(config.bot_token, channelId, userId, text, `❌ ${message}`);
    }
  }

  if (parsed.action === 'credits') {
    try {
      const credits = await getCredits(config.bloom_api_key);
      return await postCommandResponse(
        config.bot_token,
        channelId,
        userId,
        text,
        `*Bloom Credits*\nBalance: ${credits.balance ?? 'N/A'}\nUnlimited: ${credits.unlimited === null ? 'N/A' : credits.unlimited ? 'Yes' : 'No'}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to fetch credits';
      return await postCommandResponse(config.bot_token, channelId, userId, text, `❌ ${message}`);
    }
  }

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
      return await postCommandResponse(
        config.bot_token,
        channelId,
        userId,
        text,
        lines.length
          ? `*Bloom Workspaces (${lines.length})*\n${lines.join('\n')}`
          : 'No workspaces found.',
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to list workspaces';
      return await postCommandResponse(config.bot_token, channelId, userId, text, `❌ ${message}`);
    }
  }

  if (parsed.action === 'generate') {
    if (!parsed.prompt) {
      return slackResponse({
        response_type: 'ephemeral',
        text: '❌ Please add a prompt. Example: `/bloom-gen generate summer sale hero 16:9`\n\nOr mention @Bloom and describe what you need!',
      });
    }

    const loadingMsg = await postMessage(
      config.bot_token,
      channelId,
      buildLoadingBlocks(parsed.prompt, parsed.aspectRatio, userId),
      threadTs,
    );

    const jobId = await createJob({
      team_id: teamId,
      channel_id: channelId,
      user_id: userId,
      prompt: parsed.prompt,
      aspect_ratio: parsed.aspectRatio,
      variants: parsed.variants,
      brand_id: config.brand_id,
      thread_ts: threadTs ?? null,
    });

    await updateJob(jobId, { message_ts: String(loadingMsg.ts ?? ''), status: 'generating' });
    await upsertPromptTemplate({
      team_id: teamId,
      brand_id: config.brand_id,
      prompt: parsed.prompt,
      aspect_ratio: parsed.aspectRatio,
      variants: parsed.variants,
    });

    scheduleBackgroundFetch('run-generation', `${baseUrl}/api/internal/run-generation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobId }),
    });

    return new Response('', { status: 200 });
  }

  return slackResponse({
    response_type: 'ephemeral',
    text: '❌ Unknown command. Try `/bloom-gen help`.',
  });
}

async function handleInteractiveAction(data: Record<string, unknown>): Promise<Response> {
  const actions = data.actions as Array<Record<string, unknown>> | undefined;
  const action = actions?.[0];
  if (!action) return new Response('OK', { status: 200 });

  const actionId = String(action.action_id ?? '');
  const value = JSON.parse(String(action.value || '{}')) as Record<string, unknown>;
  const teamId = String((data.team as Record<string, unknown> | undefined)?.id ?? '');

  const config = await getWorkspaceConfig(teamId);
  const job = await getJob(String(value.jobId ?? ''));
  if (!config || !job) return new Response('OK', { status: 200 });

  const baseUrl = getAppBaseUrl();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (actionId === 'bloom_prev_image' || actionId === 'bloom_next_image') {
    const newIndex = Number(value.imageIndex ?? 0);
    await updateJob(String(value.jobId), { current_image_index: newIndex });
    const threadTs =
      job.thread_ts != null && String(job.thread_ts).trim() !== ''
        ? String(job.thread_ts).trim()
        : undefined;
    await updateMessage(
      config.bot_token,
      String(job.channel_id),
      String(job.message_ts),
      buildResultBlocks(
        job.prompt,
        job.aspect_ratio,
        job.image_urls,
        String(value.jobId),
        newIndex,
        String((job as { brand_name?: string }).brand_name ?? config.brand_name ?? ''),
      ),
      threadTs,
    );
  }

  if (actionId === 'bloom_regenerate') {
    const newJobId = await createJob({
      team_id: teamId,
      channel_id: job.channel_id,
      user_id: job.user_id,
      prompt: job.prompt,
      aspect_ratio: job.aspect_ratio,
      variants: job.variants,
      brand_id: job.brand_id ?? config.brand_id,
      thread_ts: job.thread_ts ?? null,
    });
    await updateJob(newJobId, { message_ts: job.message_ts, status: 'generating' });

    scheduleBackgroundFetch('run-generation', `${baseUrl}/api/internal/run-generation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobId: newJobId }),
    });
  }

  if (
    actionId === 'bloom_apply_intent' ||
    actionId.startsWith('bloom_intent_')
  ) {
    const currentIds = (job.image_ids as string[] | null) ?? [];
    const idx = Number(value.imageIndex ?? 0);
    const baseImageId = String(currentIds[idx] ?? '');
    if (!baseImageId) return new Response('', { status: 200 });

    const newJobId = await createJob({
      team_id: teamId,
      channel_id: job.channel_id,
      user_id: job.user_id,
      prompt: job.prompt,
      aspect_ratio: job.aspect_ratio,
      variants: job.variants,
      brand_id: job.brand_id ?? config.brand_id,
      source_image_id: baseImageId,
      intent: String(value.intent ?? ''),
      thread_ts: job.thread_ts ?? null,
    });
    await updateJob(newJobId, {
      message_ts: job.message_ts,
      status: 'generating',
      image_ids: job.image_ids,
      image_urls: job.image_urls,
    });

    scheduleBackgroundFetch('run-generation', `${baseUrl}/api/internal/run-generation`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jobId: newJobId,
        intent: String(value.intent ?? ''),
        imageIndex: idx,
        baseImageId,
      }),
    });
  }

  if (actionId === 'bloom_feedback' || actionId === 'bloom_feedback_up' || actionId === 'bloom_feedback_down') {
    const score = actionId === 'bloom_feedback_down'
      ? -1
      : actionId === 'bloom_feedback_up'
      ? 1
      : (Number(value.score ?? 0) >= 0 ? 1 : -1);
    const idx = Math.max(0, Number(value.imageIndex ?? 0));
    const userId = String((data.user as Record<string, unknown> | undefined)?.id ?? job.user_id ?? '');
    await recordImageFeedback({
      team_id: String(job.team_id ?? teamId),
      brand_id: String(job.brand_id ?? config.brand_id ?? ''),
      job_id: String(value.jobId),
      image_index: idx,
      user_id: userId,
      score: score as -1 | 1,
    });

    if (score > 0) {
      await upsertPromptTemplate({
        team_id: String(job.team_id ?? teamId),
        brand_id: String(job.brand_id ?? config.brand_id ?? ''),
        prompt: String(job.prompt ?? ''),
        aspect_ratio: String(job.aspect_ratio ?? '16:9'),
        variants: Number(job.variants ?? 2),
        won: true,
      });
    }

    await slackApi('chat.postEphemeral', config.bot_token, {
      channel: job.channel_id,
      user: userId,
      text: score > 0 ? 'Thanks! Saved as a winning signal.' : 'Got it - we will tune future ranking.',
    });
  }

  return new Response('', { status: 200 });
}

export async function handleSlackEventsPost(
  requestUrl: string,
  rawBody: string,
  contentType: string,
): Promise<Response> {
  const url = new URL(requestUrl);

  if (url.searchParams.get('test') === '1') {
    return new Response(JSON.stringify({ ok: true, message: 'Function is live' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(rawBody) as Record<string, unknown>;

      if (json.type === 'url_verification') {
        return new Response(JSON.stringify({ challenge: (json as { challenge?: string }).challenge }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (json.type === 'event_callback') {
        const ackResponse = new Response('', { status: 200 });
        const event = json.event as Record<string, unknown>;
        const teamId = String(json.team_id ?? '');

        if (event.bot_id || event.subtype === 'bot_message') {
          return ackResponse;
        }

        const baseUrl = getAppBaseUrl();
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

        if (event.type === 'app_mention') {
          scheduleBackgroundFetch('openai-agent', `${baseUrl}/api/internal/openai-agent`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              teamId,
              channelId: event.channel,
              userId: event.user,
              threadTs: event.thread_ts || null,
              messageTs: event.ts,
              text: event.text,
            }),
          });
          return ackResponse;
        }

        if (event.type === 'message' && event.thread_ts && !event.bot_id) {
          const supabase = createSupabaseAdmin();
          const conversation = await getConversationByThread(
            supabase,
            teamId,
            String(event.channel),
            String(event.thread_ts),
          );

          if (conversation) {
            scheduleBackgroundFetch('openai-agent', `${baseUrl}/api/internal/openai-agent`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                teamId,
                channelId: event.channel,
                userId: event.user,
                threadTs: event.thread_ts,
                messageTs: event.ts,
                text: event.text,
              }),
            });
          }
          return ackResponse;
        }

        return ackResponse;
      }
    } catch { /* ignore */ }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody);
    const interactivePayload = params.get('payload');

    if (interactivePayload) {
      return await handleInteractiveAction(JSON.parse(interactivePayload));
    }

    if (params.get('command') === '/bloom-gen') {
      return await handleSlashCommand({
        teamId: params.get('team_id') || '',
        channelId: params.get('channel_id') || '',
        userId: params.get('user_id') || '',
        text: params.get('text') || '',
        threadTs: params.get('thread_ts') || undefined,
      });
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
