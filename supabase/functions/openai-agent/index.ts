import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runAgent } from '../_shared/agent.ts';
import { getCredits, getImageUrl, listImages } from '../_shared/bloom.ts';
import {
  createJob,
  generateSetupToken,
  getConversationMessages,
  getOrCreateConversation,
  getWorkspaceConfig,
  saveMessage,
  updateCampaignContext,
  updateJob,
} from '../_shared/db.ts';
import { slackApi, truncateSlackMrkdwn } from '../_shared/slack.ts';

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

serve(async (req: Request) => {
  const body = await req.json() as {
    teamId?: string;
    channelId?: string;
    userId?: string;
    threadTs?: string | null;
    thread_ts?: string | null;
    messageTs?: string;
    text?: string;
  };
  const { teamId, channelId, userId, messageTs, text } = body;
  const threadTs = body.threadTs ?? body.thread_ts ?? null;

  if (!teamId || !channelId || !userId || !messageTs || text === undefined) {
    return new Response('Bad request', { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const config = await getWorkspaceConfig(teamId);
  if (!config) return new Response('No config', { status: 404 });

  if (!config.bloom_api_key) {
    const token = await generateSetupToken(supabase, teamId);
    const setupUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/slack-setup?token=${token}`;
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

    const messagesForModel = [...history, { role: 'user', content: cleanText }];

    const decision = await runAgent(
      messagesForModel,
      config.brand_name || 'your brand',
      config.brand_session_id || config.brand_id,
      (conversation.campaign_context as Record<string, unknown>) || {},
    );

    if (decision.action === 'switch_brand') {
      await saveMessage(supabase, String(conversation.id), 'assistant', decision.message);
      const token = await generateSetupToken(supabase, teamId);
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const setupUrl = `${supabaseUrl}/functions/v1/slack-setup?token=${token}`;
      await slackApi('chat.postMessage', config.bot_token, {
        channel: channelId,
        thread_ts: replyThreadTs,
        text: 'Bloom',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `🌸 ${decision.message}` },
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: '🔄 Change Brand' },
              url: setupUrl,
              style: 'primary',
            }],
          },
        ],
      });
      return new Response('OK', { status: 200 });
    }

    if (decision.action === 'list_images') {
      const rawLimit = Number(decision.list_images_limit ?? 15);
      const limit = Math.max(5, Math.min(25, Number.isFinite(rawLimit) ? rawLimit : 15));
      const brandSid = (config.brand_session_id || config.brand_id || '').trim() || undefined;
      const images = await fetchBloomImagesForListing(config.bloom_api_key, brandSid, limit);
      const intro = images.length > 0
        ? (decision.message?.trim() || '🌸 Here are recent Bloom images for this brand:')
        : (decision.message?.trim() ||
          "I couldn't find recent images in Bloom for this workspace/brand. Try generating one, or run `/bloom-gen images` for a full list.");
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
      await updateCampaignContext(supabase, String(conversation.id), {
        ...(conversation.campaign_context as Record<string, unknown>),
        last_request: cleanText,
        platforms,
        last_generated_at: new Date().toISOString(),
      });

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

      for (const generation of decision.generations) {
        const loadingRes = await slackApi('chat.postMessage', config.bot_token, {
          channel: channelId,
          thread_ts: replyThreadTs,
          text: 'Bloom',
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⏳ Generating *${generation.label}* (${generation.aspect_ratio})...`,
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
          brand_id: config.brand_id,
          thread_ts: replyThreadTs,
        });

        await updateJob(jobId, {
          message_ts: loadingTs,
          status: 'generating',
        });

        fetch(`${supabaseUrl}/functions/v1/run-generation`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jobId }),
        });
      }
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
});
