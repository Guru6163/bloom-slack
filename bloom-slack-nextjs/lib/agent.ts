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
        'Use when the user IS talking to Bloom: greetings, thanks, praise or critique of recent images without asking for new renders, light chit-chat, or exactly ONE clarifying question. Never queues images. If the message is not for Bloom, use slack_thread_not_for_bloom instead (in thread follow-ups).',
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
        'Use ONLY in thread follow-ups when the user is clearly NOT addressing Bloom: e.g. only @-mentioning another teammate, internal coordination ("can you check…"), bug chatter, or topics unrelated to brand images / this Slack app. Do NOT use when they @Bloom, ask for images/brands/credits, react to Bloom output, or continue a creative brief with you.',
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
        'Queue NEW image jobs ONLY when the user explicitly wants new renders: new visual brief, or words like again, another, more versions, different, regenerate, try again, new angle, same but…. NEVER for thanks, praise, thumbs-up, or "this is good" alone — use slack_reply. Never re-queue the previous task just because conversation mentioned brands earlier. Per row: optional target_brand_id / target_brand_name when that image is not for the workspace default brand.',
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

/** Omit keys starting with "_" (routing hints for this request only). */
function campaignContextForPrompt(campaignContext: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(campaignContext)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

function buildSystemPrompt(
  brandName: string,
  brandSessionId: string,
  campaignContext: Record<string, unknown>,
): string {
  const threadFollowUp = campaignContext._slack_thread_follow_up === true;
  const placement = threadFollowUp
    ? 'THREAD FOLLOW-UP: The user replied under an existing Bloom thread. First decide WHO this message is for.'
    : 'DIRECT TO BLOOM: Treat the user as speaking to Bloom unless the text clearly addresses someone else or is unrelated to brand images / this app.';

  const safeContext = campaignContextForPrompt(campaignContext);

  return `You are Bloom — a brand image assistant inside Slack. You help teams request on-brand visuals (via the Bloom product), list brands, switch workspace brand, show recent renders, and check credits.

## Hard rules
- Call exactly ONE tool per user message. Never answer with plain assistant text instead of a tool.
- Use Slack mrkdwn in user-facing strings: *bold*, _italic_, short bullets. Stay brief.
- You do not see image pixels; you only see text. Do not claim you "saw" an image file.

## ${placement}
${threadFollowUp
    ? `If the message is mainly for another person (only @them, stand-up notes, "Guru can you…", bug triage, or clearly not about Bloom), call slack_thread_not_for_bloom — prefer brief_reply "" (silence) unless one short polite line is truly helpful.
If the message is for Bloom (@Bloom, thanks/feedback on Bloom output, new image asks, brands, credits, listing images, or continuing a creative request with you), pick the matching tool below — NOT slack_thread_not_for_bloom.`
    : `If the opening message is obviously not for Bloom (wrong channel vibe is rare), still choose the best tool; when in doubt and they @Bloom or ask for image help, help them with slack_reply or Bloom tools.`}

## Choose the right tool (read the user message literally)
${threadFollowUp
    ? `**Thread replies — check audience first:** if the message is not for Bloom, slack_thread_not_for_bloom (see section above). If it is for Bloom, continue:
`
    : ''}
1. **Switch brand but no target named** → slack_unclear_brand_switch
2. **List brands / which brands** → bloom_list_brands
3. **Switch workspace default brand** (named or UUID) → bloom_select_workspace_brand
4. **List recent Bloom images** → bloom_list_recent_images
5. **Credits / balance / quota** → bloom_get_credits
6. **NEW image work only** (new brief or explicit redo / more / different / regenerate / another version) → bloom_schedule_generations
7. **Otherwise** (hello, thanks, "this is good", small talk, one missing detail, "make it warmer" without enough spec to run yet) → slack_reply

## When NOT to schedule images
- Thanks, praise, approval, or mild dislike *without* a new ask → slack_reply only. Examples: "this is good", "perfect", "thanks", "love it", "nice", "looks great", "not feeling it" with no new direction.
- If they both praise AND ask for something new, schedule only if the new ask is concrete; if ambiguous, slack_reply with ONE clarifying question.
- Never call bloom_schedule_generations just because earlier messages discussed brands or images.

## When to schedule images
- They give enough creative direction for at least one render, OR they explicitly want another run (again, regenerate, different layout, new ratio, etc.).
- After scheduling, intro_message should mention what is generating and offer ONE concrete tweak they could ask for next.

## Platform → aspect ratio
Instagram Feed → 1:1 · Instagram Story → 9:16 · Meta Ad → 4:5 · Twitter/X, LinkedIn, website hero, email header → 16:9

## Image prompt quality (for bloom_schedule_generations)
- Under ~80 words each: subject, mood, lighting, composition, brand colors where relevant.

## Multi-brand (same message, multiple brands)
- Workspace default brand is: ${brandName}. For any generation row that should use a different Bloom brand, set target_brand_id and/or target_brand_name on that row only. Omit both fields on a row to use the default. Never tell them to "pick one brand first" if they already asked for multiple brands in one go.

## Current workspace
- Brand name: ${brandName}
- Brand session id: ${brandSessionId}
- Campaign context (JSON, internal routing keys removed): ${JSON.stringify(safeContext)}`;
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
