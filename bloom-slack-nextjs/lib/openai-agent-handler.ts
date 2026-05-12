import { createSupabaseAdmin } from './supabase-admin';
import { runAgent } from './agent';
import { formatSlackBrandsList, getCredits, getImageUrl, listBrands, listImages, pickBrandForWorkspace } from './bloom';
import {
  createJob,
  generateSetupToken,
  getConversationMessages,
  getOrCreateConversation,
  getWorkspaceConfig,
  saveMessage,
  updateCampaignContext,
  updateJob,
} from './db';
import { slackApi, truncateSlackMrkdwn } from './slack';
import { getAppBaseUrl } from './app-url';
import { scheduleBackgroundFetch } from './schedule-background-fetch';

async function fetchBloomImagesForListing(
  apiKey: string,
  brandSessionId: string | undefined,
  limit: number,
): Promise<unknown[]> {
  const attempts: Array<{ brandSessionId?: string; source?: string; status?: string } | undefined> = [
    brandSessionId
      ? { brandSessionId, source: 'generated', status: 'completed' }
      : { source: 'generated', status: 'completed' },
    brandSessionId ? { brandSessionId } : undefined,
    {},
  ];
  for (const opts of attempts) {
    const rows = await listImages(apiKey, limit, opts);
    if (rows.length > 0) return rows;
  }
  return [];
}

function buildImageListMrkdwn(images: unknown[]): string {
  const lines: string[] = [];
  for (const item of images) {
    if (!item || typeof item !== 'object') continue;
    const img = item as Record<string, unknown>;
    const id = String(img.id ?? img.imageId ?? '—');
    const status = String(img.status ?? '—');
    const prompt = String(img.prompt ?? img.description ?? '').trim().replace(/\n/g, ' ');
    const clip = prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt;
    const url = getImageUrl(img);
    const link = url && /^https?:\/\//i.test(url) ? `<${url}|open>` : '—';
    lines.push(`• \`${id}\` · ${status}${clip ? ` · _${clip}_` : ''} · ${link}`);
  }
  return lines.join('\n') || '_No images returned from Bloom for this query._';
}

/**
 * Plain-text assignment to another person (no Slack @), e.g. "Guru should start working on…".
 * Slack strips <@U…> into cleanText — those are handled by the model; this catches "Name should…".
 */
function looksLikeAssigningWorkToSomeoneElse(cleanText: string, isThreadFollowUp: boolean): boolean {
  if (!isThreadFollowUp) return false;
  const t = cleanText.trim();
  const lead = t.match(/^([A-Z][a-z]{2,19})\s+(should|will|needs to|can)\s+(start|work|begin|focus|handle|own|take|build|ship|do)\b/i);
  if (!lead) return false;
  const name = lead[1]!.toLowerCase();
  if (name === 'bloom' || name === 'team' || name === 'everyone' || name === 'someone' || name === 'everybody') {
    return false;
  }
  if (
    /\b(bloom|image|images|generate|regenerate|hero|carousel|brands?|credits?|visual|mockup|creative|banners?|ads?|ratios?|photos?|pictures?|assets?|thumbnails?|instagram|linkedin|twitter|covers?|slack)\b/i
      .test(t)
  ) {
    return false;
  }
  return true;
}

/** Short thread replies about coding/time, with no Bloom/visual ask in the same line. */
function looksLikeTeamCoordinationWithoutBloomAsk(cleanText: string, isThreadFollowUp: boolean): boolean {
  if (!isThreadFollowUp) return false;
  const t = cleanText.trim();
  if (t.length > 160) return false;
  if (
    /\b(bloom|image|images|generate|regenerate|brands?|credits?|visual|mockup|creative|banner|ad\b|hero|ratio|thumbnail|instagram|linkedin|twitter)\b/i
      .test(t)
  ) {
    return false;
  }
  const dev =
    /\b(let'?s\s+write\s+code|let'?s\s+code|don'?t\s+have\s+time|do\s+not\s+have\s+time|no\s+time|out\s+of\s+time|skip\s+(\w+\s+)?for\s+now|write\s+code|ship\s+code|pull\s+request|merge\s+(\w+\s+)?pr|sprint\b|story\s+points)\b/i;
  return dev.test(t.toLowerCase());
}

export async function handleOpenAiAgentRequest(body: {
  teamId?: string;
  channelId?: string;
  userId?: string;
  threadTs?: string | null;
  thread_ts?: string | null;
  messageTs?: string;
  text?: string;
}): Promise<Response> {
  const { teamId, channelId, userId, messageTs, text } = body;
  const threadTs = body.threadTs ?? body.thread_ts ?? null;

  if (!teamId || !channelId || !userId || !messageTs || text === undefined) {
    return new Response('Bad request', { status: 400 });
  }

  const supabase = createSupabaseAdmin();

  const config = await getWorkspaceConfig(teamId);
  if (!config) {
    console.warn(
      `[openai-agent] No workspace_configs row for team_id=${teamId}. Install/reinstall the Slack app via this app's OAuth so the bot token is saved.`,
    );
    return new Response('No workspace config for this Slack team', { status: 503 });
  }

  const baseUrl = getAppBaseUrl();

  if (!String(config.bloom_api_key ?? '').trim()) {
    const token = await generateSetupToken(supabase, teamId);
    const setupUrl = `${baseUrl}/api/slack/setup?token=${token}`;
    await slackApi('chat.postMessage', config.bot_token, {
      channel: channelId,
      thread_ts: threadTs || messageTs,
      text: `🌸 Bloom isn't set up yet. Ask your workspace admin to visit:\n${setupUrl}`,
    });
    return new Response('OK', { status: 200 });
  }

  const cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!cleanText) return new Response('OK', { status: 200 });

  const replyThreadTs = threadTs || messageTs;

  try {
    const conversation = await getOrCreateConversation(
      supabase,
      teamId,
      channelId,
      replyThreadTs,
      userId,
    );

    const history = await getConversationMessages(supabase, String(conversation.id));
    await saveMessage(supabase, String(conversation.id), 'user', cleanText);

    const threadTsStr = threadTs != null ? String(threadTs).trim() : '';
    const messageTsStr = String(messageTs ?? '').trim();
    const isThreadFollowUp = Boolean(threadTsStr && messageTsStr && threadTsStr !== messageTsStr);

    if (
      looksLikeAssigningWorkToSomeoneElse(cleanText, isThreadFollowUp) ||
      looksLikeTeamCoordinationWithoutBloomAsk(cleanText, isThreadFollowUp)
    ) {
      return new Response('OK', { status: 200 });
    }

    const messagesForModel = [...history, { role: 'user', content: cleanText }];

    const campaign = (conversation.campaign_context as Record<string, unknown>) || {};
    const modelCampaignContext: Record<string, unknown> = {
      ...campaign,
      ...(isThreadFollowUp ? { _slack_thread_follow_up: true } : {}),
    };

    const decision = await runAgent(messagesForModel, modelCampaignContext);

    if (decision.action === 'stand_down') {
      const note = String(decision.message ?? '').trim();
      if (note) {
        const body = `🌸 ${note}`;
        await saveMessage(supabase, String(conversation.id), 'assistant', body.slice(0, 8000));
        await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: truncateSlackMrkdwn(body, 2800) },
          }],
        });
      }
      return new Response('OK', { status: 200 });
    }

    if (decision.action === 'list_brands') {
      try {
        const brands = await listBrands(config.bloom_api_key);
        const listMd = formatSlackBrandsList(brands);
        const intro = decision.message?.trim() || '🌸 Brands on your Bloom account:';
        const combined = `${intro}\n\n${listMd}`;
        await saveMessage(supabase, String(conversation.id), 'assistant', combined.slice(0, 8000));
        await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom — brands',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: truncateSlackMrkdwn(combined, 2800) },
          }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unable to list brands';
        await saveMessage(supabase, String(conversation.id), 'assistant', `❌ ${message}`);
        await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom — brands error',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `❌ ${message}` },
          }],
        });
      }
      return new Response('OK', { status: 200 });
    }

    if (decision.action === 'list_images') {
      const rawLimit = Number(decision.list_images_limit ?? 15);
      const limit = Math.max(5, Math.min(25, Number.isFinite(rawLimit) ? rawLimit : 15));
      const images = await fetchBloomImagesForListing(config.bloom_api_key, undefined, limit);
      const intro = images.length > 0
        ? (decision.message?.trim() || '🌸 Here are recent Bloom images for this brand:')
        : (decision.message?.trim() ||
          "I couldn't find recent images in Bloom for this account. Try generating one, or run `/bloom-gen images` for a full list.");
      const listMd = images.length > 0 ? buildImageListMrkdwn(images) : '';
      const combined = listMd ? `${intro}\n\n${listMd}` : intro;
      await saveMessage(supabase, String(conversation.id), 'assistant', combined.slice(0, 8000));
      await slackApi('chat.postMessage', config.bot_token, {
        channel: channelId,
        thread_ts: replyThreadTs,
        text: 'Bloom — recent images',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: truncateSlackMrkdwn(combined, 2800) },
        }],
      });
      return new Response('OK', { status: 200 });
    }

    if (decision.action === 'credits') {
      try {
        const credits = await getCredits(config.bloom_api_key);
        const stats =
          `*Bloom Credits*\nBalance: ${credits.balance ?? 'N/A'}\nUnlimited: ${credits.unlimited === null ? 'N/A' : credits.unlimited ? 'Yes' : 'No'}`;
        const intro = decision.message?.trim();
        const combined = intro ? `${intro}\n\n${stats}` : `🌸 ${stats}`;
        await saveMessage(supabase, String(conversation.id), 'assistant', combined.slice(0, 8000));
        await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom — credits',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: truncateSlackMrkdwn(combined, 2800) },
          }],
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unable to fetch credits';
        await saveMessage(supabase, String(conversation.id), 'assistant', `❌ ${message}`);
        await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom — credits error',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `❌ ${message}` },
          }],
        });
      }
      return new Response('OK', { status: 200 });
    }

    if (decision.action === 'none' || decision.action === 'clarify') {
      await saveMessage(supabase, String(conversation.id), 'assistant', decision.message);
      await slackApi('chat.postMessage', config.bot_token, {
        channel: channelId,
        thread_ts: replyThreadTs,
        text: 'Bloom',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `🌸 ${decision.message}` },
        }],
      });
      return new Response('OK', { status: 200 });
    }

    if (decision.action === 'generate' || decision.action === 'generate_multiple') {
      await saveMessage(supabase, String(conversation.id), 'assistant', decision.message);
      await slackApi('chat.postMessage', config.bot_token, {
        channel: channelId,
        thread_ts: replyThreadTs,
        text: 'Bloom',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `🌸 ${decision.message}` },
        }],
      });

      const platforms = decision.generations.map((g) => g.platform);
      const campaignBase = (conversation.campaign_context as Record<string, unknown>) || {};
      const lastBloomId = String(campaignBase.last_bloom_brand_id ?? '').trim();
      const lastBloomName = String(campaignBase.last_bloom_brand_name ?? '').trim();

      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

      let firstScheduledBrand: { id: string; name: string } | null = null;

      for (const generation of decision.generations) {
        const tid = String(generation.target_brand_id ?? '').trim();
        const tname = String(generation.target_brand_name ?? '').trim();
        let resolvedBrandId = '';
        let resolvedBrandName = '';

        if (tid || tname) {
          const picked = await pickBrandForWorkspace(config.bloom_api_key, {
            brandId: tid || undefined,
            brandNameHint: tid ? undefined : (tname || undefined),
          });
          if (!picked.ok) {
            await slackApi('chat.postMessage', config.bot_token, {
              channel: channelId,
              thread_ts: replyThreadTs,
              text: 'Bloom',
              blocks: [{
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: truncateSlackMrkdwn(`❌ *${generation.label}:* ${picked.message}`),
                },
              }],
            });
            continue;
          }
          resolvedBrandId = picked.id;
          resolvedBrandName = picked.name;
        } else if (lastBloomId || lastBloomName) {
          const picked = await pickBrandForWorkspace(config.bloom_api_key, {
            brandId: lastBloomId || undefined,
            brandNameHint: lastBloomId ? undefined : (lastBloomName || undefined),
          });
          if (!picked.ok) {
            await slackApi('chat.postMessage', config.bot_token, {
              channel: channelId,
              thread_ts: replyThreadTs,
              text: 'Bloom',
              blocks: [{
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: truncateSlackMrkdwn(
                    `❌ *${generation.label}:* ${picked.message} Say which brand (name or ID), or run \`/bloom-gen brands\`.`,
                  ),
                },
              }],
            });
            continue;
          }
          resolvedBrandId = picked.id;
          resolvedBrandName = picked.name;
        } else {
          await slackApi('chat.postMessage', config.bot_token, {
            channel: channelId,
            thread_ts: replyThreadTs,
            text: 'Bloom',
            blocks: [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: truncateSlackMrkdwn(
                  `❌ *${generation.label}:* Say which Bloom brand to use (name or UUID in this message). Run \`/bloom-gen brands\` to list.`,
                ),
              },
            }],
          });
          continue;
        }

        const brandNote = resolvedBrandName ? ` · _${resolvedBrandName}_` : '';

        const loadingRes = await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom',
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⏳ Generating *${generation.label}* (${generation.aspect_ratio})${brandNote}...`,
            },
          }],
        });

        const loadingTs = String(loadingRes.ts ?? '');

        const jobId = await createJob({
          team_id: teamId,
          channel_id: channelId,
          user_id: userId,
          prompt: generation.prompt,
          aspect_ratio: generation.aspect_ratio,
          variants: generation.variants || 2,
          brand_id: resolvedBrandId,
          ...(resolvedBrandName ? { brand_name: resolvedBrandName } : {}),
          thread_ts: replyThreadTs,
        });

        if (!firstScheduledBrand) {
          firstScheduledBrand = { id: resolvedBrandId, name: resolvedBrandName };
        }

        await updateJob(jobId, {
          message_ts: loadingTs,
          status: 'generating',
        });

        scheduleBackgroundFetch('run-generation', `${baseUrl}/api/internal/run-generation`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jobId }),
        });
      }

      await updateCampaignContext(supabase, String(conversation.id), {
        ...campaignBase,
        last_request: cleanText,
        platforms,
        last_generated_at: new Date().toISOString(),
        ...(firstScheduledBrand
          ? {
            last_bloom_brand_id: firstScheduledBrand.id,
            last_bloom_brand_name: firstScheduledBrand.name,
          }
          : {}),
      });
    }

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('openai-agent error:', msg);
    await slackApi('chat.postMessage', config.bot_token, {
      channel: channelId,
      thread_ts: replyThreadTs,
      text: `❌ Something went wrong. Try again or use \`/bloom-gen generate\` for a direct command.`,
    });
    return new Response('Error', { status: 500 });
  }
}
