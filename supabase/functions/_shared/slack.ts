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

export function buildLoadingBlocks(prompt: string, ratio: string, userId: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `🌸 *Generating your image...*\n\n*Prompt:* ${prompt}\n*Ratio:* ${ratio}\n*Requested by:* <@${userId}>`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⏳ Usually takes 10–30 seconds...' }],
    },
  ];
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
          text: { type: 'plain_text', text: '✏️ Edit' },
          value: JSON.stringify({ jobId, imageIndex: currentIndex }),
          action_id: 'bloom_open_edit_modal',
        },
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
          '*Commands:*\n`/bloom-gen generate {prompt} {ratio}` — Generate images\n`/bloom-gen setup <bloom_api_key> [brand_id]` — Connect workspace Bloom account\n`/bloom-gen brand [brand_id]` — View configured or specific brand\n`/bloom-gen brands` — List available brands\n`/bloom-gen images [limit]` — List recent images\n`/bloom-gen image <image_id>` — Get image details\n`/bloom-gen help` — Show this message',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Ratios:* `1:1` `16:9` `9:16` `4:5` `square` `landscape` `portrait` `story`\n\n*Examples:*\n`/bloom-gen generate summer sale hero 16:9`\n`/bloom-gen brands`\n`/bloom-gen images 10`\n`/bloom-gen image img_abc123`',
      },
    },
  ];
}
