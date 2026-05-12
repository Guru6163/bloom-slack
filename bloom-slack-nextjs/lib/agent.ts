const OPENAI_BASE = 'https://api.openai.com/v1';

const generationItemSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Detailed image prompt (under ~80 words).' },
    aspect_ratio: { type: 'string', description: 'e.g. 16:9, 1:1, 9:16, 4:5' },
    variants: { type: 'integer', description: 'Number of variants (1–4).', minimum: 1, maximum: 4 },
    platform: { type: 'string', description: 'Label for context, e.g. Twitter, Instagram Feed.' },
    label: { type: 'string', description: 'Short label for Slack status, e.g. Hero shot.' },
    target_brand_id: {
      type: 'string',
      description: 'Optional Bloom brand UUID for this image only; omit to use workspace default.',
    },
    target_brand_name: {
      type: 'string',
      description: 'Optional Bloom brand name for this image only when no ID; omit for default.',
    },
  },
  required: ['prompt', 'aspect_ratio', 'variants', 'platform', 'label'],
  additionalProperties: false,
} as const;

const AGENT_TOOLS: unknown[] = [
  {
    type: 'function',
    function: {
      name: 'slack_reply',
      description:
        'Send a short Slack reply for greetings, thanks, chit-chat, or a single clarifying question when you cannot call another tool yet.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Slack mrkdwn body (brief).' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_thread_not_for_bloom',
      description:
        'Use when this message is clearly for another teammate (e.g. only @-mentioning them), or is off-topic housekeeping, not a request to Bloom. Prefer empty brief_reply for silence.',
      parameters: {
        type: 'object',
        properties: {
          brief_reply: {
            type: 'string',
            description:
              'EMPTY string = post nothing to Slack (stay out of the conversation). Non-empty = one very short Slack mrkdwn line (e.g. polite step-back).',
          },
        },
        required: ['brief_reply'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_unclear_brand_switch',
      description:
        'User wants to change Bloom brand but gave no target name or ID. Suggest they name a brand or paste an ID.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Helpful Slack mrkdwn instructions.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bloom_list_brands',
      description: 'List all Bloom brands on the account (names and IDs).',
      parameters: {
        type: 'object',
        properties: {
          intro_message: {
            type: 'string',
            description: 'Short intro line before the directory is appended.',
          },
        },
        required: ['intro_message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bloom_select_workspace_brand',
      description:
        'Switch the Slack workspace default Bloom brand to the named or ID-specified brand.',
      parameters: {
        type: 'object',
        properties: {
          intro_message: { type: 'string', description: 'Brief acknowledgment in Slack mrkdwn.' },
          target_brand_id: { type: 'string', description: 'Bloom brand UUID if the user gave one.' },
          target_brand_name: { type: 'string', description: 'Brand name to fuzzy-match if no UUID.' },
        },
        required: ['intro_message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bloom_list_recent_images',
      description: 'Show recent generated images for the current workspace brand from Bloom.',
      parameters: {
        type: 'object',
        properties: {
          intro_message: { type: 'string', description: 'Short intro; URLs are filled in by the app.' },
          limit: {
            type: 'integer',
            description: 'How many images to list (5–25).',
            minimum: 5,
            maximum: 25,
          },
        },
        required: ['intro_message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bloom_get_credits',
      description: 'Fetch Bloom credit balance for the workspace.',
      parameters: {
        type: 'object',
        properties: {
          intro_message: { type: 'string', description: 'Short intro; numbers are filled in by the app.' },
        },
        required: ['intro_message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bloom_schedule_generations',
      description:
        'Queue one or more Bloom image generations. Use one item for a single image, 2–6 items for multiple platforms or brands. Per-item target_brand_* only when that image is for a non-default brand.',
      parameters: {
        type: 'object',
        properties: {
          intro_message: {
            type: 'string',
            description: 'What you told the user you will generate (Slack mrkdwn).',
          },
          generations: {
            type: 'array',
            description: 'Each entry becomes one async generation job.',
            minItems: 1,
            maxItems: 6,
            items: generationItemSchema as unknown as Record<string, unknown>,
          },
        },
        required: ['intro_message', 'generations'],
        additionalProperties: false,
      },
    },
  },
];

export interface AgentDecision {
  message: string;
  action:
    | 'none'
    | 'clarify'
    | 'generate'
    | 'generate_multiple'
    | 'switch_brand'
    | 'list_brands'
    | 'select_brand'
    | 'list_images'
    | 'credits'
    | 'stand_down';
  generations: {
    prompt: string;
    aspect_ratio: string;
    variants: number;
    platform: string;
    label: string;
    target_brand_id?: string;
    target_brand_name?: string;
  }[];
  list_images_limit?: number;
  target_brand_id?: string;
  target_brand_name?: string;
}

function buildSystemPrompt(
  brandName: string,
  brandSessionId: string,
  campaignContext: Record<string, unknown>,
): string {
  return `You are Bloom, an AI brand asset generator living in Slack.
You help marketing teams create on-brand images for campaigns, launches, and social media.

TOOL USE (required):
- You MUST call exactly one function per user message. Never send a bare assistant text reply instead of a tool call.

THREAD AWARENESS (when Campaign history includes "_slack_thread_follow_up": true):
- This user message is a reply inside an existing Bloom thread, not the first @Bloom in the channel.
- If they are clearly talking to another person (e.g. @-mentioning only someone else, coordinating with a teammate, or discussing a bug/fix unrelated to brand images), call slack_thread_not_for_bloom with brief_reply "" for silence, or one very short polite line if a tiny acknowledgment feels appropriate.
- If they still want Bloom (image work, brands, credits, listing images, clarifying a prior Bloom request, or @Bloom is in the message), use the appropriate Bloom tool or slack_reply — do not use slack_thread_not_for_bloom.

PERSONALITY:
- Friendly, brief, creative
- Ask maximum ONE clarifying question before generating (use slack_reply)
- Keep replies short — this is Slack, not email
- Never ask multiple questions at once
- After scheduling generations, offer ONE specific adjustment option in intro_message

WORKFLOW:
1. User describes what they need
2. If ONE critical thing is missing → slack_reply with that question
3. When ready → bloom_schedule_generations

PLATFORM TO ASPECT RATIO:
Instagram Feed → 1:1
Instagram Story → 9:16
Meta Ad → 4:5
Twitter/X → 16:9
LinkedIn → 16:9
Website Hero → 16:9
Email Header → 16:9

PROMPT WRITING:
- Be specific and visual
- Include: subject, mood, lighting, composition
- Reference brand colors and style naturally
- Keep each prompt under 80 words

BRAND — LIST:
If the user asks to list brands, "what brands", "show brands", "which brand is connected":
- Call bloom_list_brands

BRAND — SWITCH WORKSPACE DEFAULT:
If the user wants a *different* default brand and names it or gives an ID (e.g. "switch to Acme", "use brand \`uuid\`"):
- Call bloom_select_workspace_brand with target_brand_id and/or target_brand_name

BRAND — UNCLEAR SWITCH:
If they want to change brand but give no target (e.g. "switch brand" with no name/ID):
- Call slack_unclear_brand_switch

BRAND — MULTIPLE BRANDS IN ONE REQUEST:
When the user wants images for more than one Bloom brand in one reply, set target_brand_id or target_brand_name on each generation row that is not for the workspace default (${brandName}). Omit both on a row to use the default. Do not tell them to pick one brand first when they clearly asked for multiple brands.

LIST / SHOW IMAGES:
If the user asks to see recent images, gallery, "what did we generate":
- Call bloom_list_recent_images (set limit 5–25 if they ask for a count)

CREDITS / BALANCE:
If the user asks about credits, balance, quota:
- Call bloom_get_credits

GENERATION:
When you have enough detail (or user deferred platform choice to you), call bloom_schedule_generations with intro_message and generations array (1 item = single generate; 2–6 = multiple).

CURRENT CONTEXT:
Brand: ${brandName}
Brand Session ID: ${brandSessionId}
Campaign history: ${JSON.stringify(campaignContext)}`;
}

type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeGenerationRow(
  row: Record<string, unknown>,
): AgentDecision['generations'][0] | null {
  const prompt = String(row.prompt ?? '').trim();
  const aspect_ratio = String(row.aspect_ratio ?? '16:9').trim();
  const platform = String(row.platform ?? '').trim() || 'Custom';
  const label = String(row.label ?? '').trim() || platform;
  const variantsRaw = Number(row.variants ?? 2);
  const variants = Math.max(1, Math.min(4, Number.isFinite(variantsRaw) ? variantsRaw : 2));
  if (!prompt) return null;
  const tid = String(row.target_brand_id ?? '').trim();
  const tname = String(row.target_brand_name ?? '').trim();
  return {
    prompt,
    aspect_ratio,
    variants,
    platform,
    label,
    ...(tid ? { target_brand_id: tid } : {}),
    ...(tname ? { target_brand_name: tname } : {}),
  };
}

function toolCallToDecision(name: string, args: Record<string, unknown>): AgentDecision {
  const str = (k: string) => String(args[k] ?? '').trim();

  switch (name) {
    case 'slack_reply':
      return { action: 'clarify', message: str('message') || 'How can I help?', generations: [] };
    case 'slack_thread_not_for_bloom':
      return { action: 'stand_down', message: str('brief_reply'), generations: [] };
    case 'slack_unclear_brand_switch':
      return { action: 'switch_brand', message: str('message'), generations: [] };
    case 'bloom_list_brands':
      return {
        action: 'list_brands',
        message: str('intro_message') || '🌸 Brands on your Bloom account:',
        generations: [],
      };
    case 'bloom_select_workspace_brand': {
      const tid = str('target_brand_id');
      const tname = str('target_brand_name');
      return {
        action: 'select_brand',
        message: str('intro_message'),
        generations: [],
        ...(tid ? { target_brand_id: tid } : {}),
        ...(tname ? { target_brand_name: tname } : {}),
      };
    }
    case 'bloom_list_recent_images': {
      const lim = Number(args.limit ?? 15);
      return {
        action: 'list_images',
        message: str('intro_message') || '🌸 Here are recent Bloom images for this brand:',
        generations: [],
        list_images_limit: Math.max(5, Math.min(25, Number.isFinite(lim) ? lim : 15)),
      };
    }
    case 'bloom_get_credits':
      return {
        action: 'credits',
        message: str('intro_message') || '🌸 Here is your Bloom credit balance:',
        generations: [],
      };
    case 'bloom_schedule_generations': {
      const intro = str('intro_message') || '🌸 Generating your images…';
      const rawGens = args.generations;
      const generations: AgentDecision['generations'] = [];
      if (Array.isArray(rawGens)) {
        for (const item of rawGens) {
          if (!item || typeof item !== 'object') continue;
          const row = normalizeGenerationRow(item as Record<string, unknown>);
          if (row) generations.push(row);
        }
      }
      if (!generations.length) {
        return {
          action: 'clarify',
          message:
            'I could not read any image specs from that request. What subject, aspect ratio, and platform should I use?',
          generations: [],
        };
      }
      const action: AgentDecision['action'] = generations.length > 1 ? 'generate_multiple' : 'generate';
      return { action, message: intro, generations };
    }
    default:
      return {
        action: 'clarify',
        message: 'Something was unclear. What would you like to create?',
        generations: [],
      };
  }
}

function decisionFromAssistantMessage(message: {
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
}): AgentDecision {
  const calls = message.tool_calls;
  if (calls && calls.length > 0) {
    const tc = calls[0];
    const fnName = String(tc?.function?.name ?? '').trim();
    const args = parseToolArguments(tc?.function?.arguments);
    return toolCallToDecision(fnName, args);
  }
  const text = String(message.content ?? '').trim();
  if (text) {
    return { action: 'none', message: text, generations: [] };
  }
  return { action: 'clarify', message: 'How can I help you today?', generations: [] };
}

export async function runAgent(
  messages: { role: string; content: string }[],
  brandName: string,
  brandSessionId: string,
  campaignContext: Record<string, unknown> = {},
): Promise<AgentDecision> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set');

  const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: buildSystemPrompt(brandName, brandSessionId, campaignContext) },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      tools: AGENT_TOOLS,
      tool_choice: 'required',
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`OpenAI error: ${err?.error?.message || response.status}`);
  }

  const data = await response.json() as {
    choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) {
    return { action: 'clarify', message: 'No response from the model. Try again.', generations: [] };
  }

  const decision = decisionFromAssistantMessage(message);
  const allowed = new Set([
    'none',
    'clarify',
    'generate',
    'generate_multiple',
    'switch_brand',
    'list_brands',
    'select_brand',
    'list_images',
    'credits',
    'stand_down',
  ]);
  if (!allowed.has(decision.action)) decision.action = 'none';
  if (!decision.generations) decision.generations = [];
  return decision;
}
