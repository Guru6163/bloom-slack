export async function slackApi(
  endpoint: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

export async function updateMessage(
  botToken: string,
  channel: string,
  ts: string,
  blocks: unknown[],
): Promise<void> {
  await slackApi('chat.update', botToken, { channel, ts, blocks });
}

export async function postMessage(
  botToken: string,
  channel: string,
  blocks: unknown[],
  threadTs?: string,
): Promise<Record<string, unknown>> {
  return slackApi('chat.postMessage', botToken, {
    channel,
    blocks,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

type ProgressStage = 'queued' | 'generating' | 'finalizing' | 'done';

export function buildRequestBlocks(prompt: string, ratio: string, userId: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👤 <@${userId}> requested a Bloom generation\n*Prompt:* ${prompt}\n*Ratio:* ${ratio}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Bot updates and results will appear in this thread.' }],
    },
  ];
}

export function buildLoadingBlocks(prompt: string, ratio: string, userId: string): unknown[] {
  return buildProgressBlocks(prompt, ratio, userId, 'queued');
}

export function buildProgressBlocks(
  prompt: string,
  ratio: string,
  userId: string,
  stage: ProgressStage,
  templates: string[] = [],
): unknown[] {
  const status = {
    queued: '⏳',
    generating: '🔄',
    finalizing: '🧩',
    done: '✅',
  };
  const stageLine = [
    `${stage === 'queued' ? '🟢' : '⚪'} Queued`,
    `${stage === 'generating' ? '🟢' : stage === 'queued' ? '⚪' : '⚪'} Generating variants`,
    `${stage === 'finalizing' ? '🟢' : (stage === 'done' ? '⚪' : '⚪')} Finalizing assets`,
    `${stage === 'done' ? '🟢' : '⚪'} Done`,
  ].join('  •  ');

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${status[stage]} *Bloom generation in progress*\n\n*Prompt:* ${prompt}\n*Ratio:* ${ratio}\n*Requested by:* <@${userId}>`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: stageLine }],
    },
  ];

  if (templates.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Top winning prompts in this workspace:*\n${templates.map((t) => `• ${t}`).join('\n')}`,
      },
    });
  }

  return blocks;
}

export function buildResultBlocks(
  prompt: string,
  ratio: string,
  imageUrls: string[],
  jobId: string,
  currentIndex: number,
  brandName?: string,
): unknown[] {
  const currentUrl = imageUrls[currentIndex];
  const total = imageUrls.length;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `🌸 *${prompt}*\n${ratio} · ${brandName || 'Bloom'} · Image ${currentIndex + 1} of ${total}`,
      },
    },
    {
      type: 'image',
      image_url: currentUrl,
      alt_text: prompt,
    },
    {
      type: 'actions',
      elements: [
        ...(total > 1
          ? [
              {
                type: 'button',
                text: { type: 'plain_text', text: '◀' },
                value: JSON.stringify({ jobId, imageIndex: Math.max(0, currentIndex - 1) }),
                action_id: 'bloom_prev_image',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '▶' },
                value: JSON.stringify({ jobId, imageIndex: Math.min(total - 1, currentIndex + 1) }),
                action_id: 'bloom_next_image',
              },
            ]
          : []),
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Regenerate' },
          value: JSON.stringify({ jobId }),
          action_id: 'bloom_regenerate',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⬇️ Download' },
          url: currentUrl,
          action_id: 'bloom_download',
          style: 'primary',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💎 More premium' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex, intent: 'premium' }),
          action_id: 'bloom_apply_intent',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '☀️ Brighter' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex, intent: 'brighter' }),
          action_id: 'bloom_apply_intent',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📦 Product-focused' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex, intent: 'product' }),
          action_id: 'bloom_apply_intent',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🎄 Holiday mood' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex, intent: 'holiday' }),
          action_id: 'bloom_apply_intent',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '👍' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex, score: 1 }),
          action_id: 'bloom_feedback',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '👎' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex, score: -1 }),
          action_id: 'bloom_feedback',
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Powered by 🌸 *Bloom* · trybloom.ai' }],
    },
  ];
}

export function buildErrorBlocks(prompt: string, error: string, jobId: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `❌ *Generation failed*\n*Prompt:* ${prompt}\n*Error:* ${error}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Try Again' },
          value: JSON.stringify({ jobId }),
          action_id: 'bloom_regenerate',
          style: 'primary',
        },
      ],
    },
  ];
}

export function buildHelpBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*🌸 Bloom — On-Brand Image Generator*',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Commands:*\n`/bloom-gen generate {prompt} {ratio}` — Generate images\n`/bloom-gen setup <bloom_api_key> [brand_id]` — Connect workspace Bloom account\n`/bloom-gen brand [brand_id]` — View configured or specific brand\n`/bloom-gen brands` — List available brands\n`/bloom-gen images [limit]` — List recent images\n`/bloom-gen image <image_id>` — Get image details\n`/bloom-gen credits` — Check credit balance\n`/bloom-gen workspaces` — List accessible workspaces\n`/bloom-gen help` — Show this message',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Ratios:* `1:1` `16:9` `9:16` `4:5` `square` `landscape` `portrait` `story`\n\n*Examples:*\n`/bloom-gen generate summer sale hero 16:9`\n`/bloom-gen brands`\n`/bloom-gen images 10`\n`/bloom-gen image 123e4567-e89b-12d3-a456-426614174000`\n`/bloom-gen credits`',
      },
    },
  ];
}
