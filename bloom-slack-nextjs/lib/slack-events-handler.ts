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
  pickBrandForWorkspace,
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
    if (!apiKey) {
      return slackResponse({
        response_type: 'ephemeral',
        text:
          'To connect Bloom for this workspace, run:\n' +
          '`/bloom-gen setup <bloom_api_key>`\n\n' +
          'Your API key unlocks all brands on the account. Pick a brand per generation (in chat or with `--brand` on `/bloom-gen generate`).\n\n' +
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

    await saveWorkspaceConfig({
      team_id: teamId,
      bloom_api_key: apiKey,
      brand_id: '',
      brand_name: '',
      brand_session_id: '',
      setup_completed: true,
    });

    return slackResponse({
      response_type: 'ephemeral',
      text:
        '✅ Bloom connected for this workspace.\n\n' +
        'Mention @Bloom with which brand to use, or run:\n' +
        '`/bloom-gen generate <prompt> <ratio> --brand <brand_uuid>`\n\n' +
        'Use `/bloom-gen brands` to list brand IDs.',
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

    return await postCommandResponse(
      config.bot_token,
      channelId,
      userId,
      text,
      'This workspace does not store a default brand. Use `/bloom-gen brands` for IDs, `/bloom-gen brand <id>` to inspect a brand, or mention @Bloom with a brand name when generating.',
    );
  }

  if (parsed.action === 'brands') {
    try {
      const brands = await listBrands(config.bloom_api_key);
      const body = formatSlackBrandsList(brands);
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
        text:
          '❌ Please add a prompt. Example:\n' +
          '`/bloom-gen generate summer sale hero 16:9 --brand <your_bloom_brand_uuid>`\n\n' +
          'Use `/bloom-gen brands` to list brand IDs, or mention @Bloom in a channel.',
      });
    }

    const brandUuid = String(parsed.generateBrandId ?? '').trim();
    if (!brandUuid) {
      return slackResponse({
        response_type: 'ephemeral',
        text:
          '❌ Add `--brand` with a Bloom brand UUID. Example:\n' +
          '`/bloom-gen generate summer sale hero 16:9 --brand 123e4567-e89b-12d3-a456-426614174000`\n\n' +
          'Run `/bloom-gen brands` to list IDs.',
      });
    }

    const picked = await pickBrandForWorkspace(config.bloom_api_key, { brandId: brandUuid });
    if (!picked.ok) {
      return slackResponse({
        response_type: 'ephemeral',
        text: `❌ ${picked.message}`,
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
      brand_id: picked.id,
      ...(picked.name ? { brand_name: picked.name } : {}),
      thread_ts: threadTs ?? null,
    });

    await updateJob(jobId, { message_ts: String(loadingMsg.ts ?? ''), status: 'generating' });
    await upsertPromptTemplate({
      team_id: teamId,
      brand_id: picked.id,
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
          if (String(event.subtype ?? '').trim()) {
            return ackResponse;
          }

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
