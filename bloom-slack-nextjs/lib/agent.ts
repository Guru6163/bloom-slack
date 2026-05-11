const OPENAI_BASE = 'https://api.openai.com/v1';

export interface AgentDecision {
  message: string;
  action: 'none' | 'clarify' | 'generate' | 'generate_multiple' | 'switch_brand' | 'list_images';
  generations: {
    prompt: string;
    aspect_ratio: string;
    variants: number;
    platform: string;
    label: string;
  }[];
  list_images_limit?: number;
}

function buildSystemPrompt(
  brandName: string,
  brandSessionId: string,
  campaignContext: Record<string, unknown>,
): string {
  return `You are Bloom, an AI brand asset generator living in Slack.
You help marketing teams create on-brand images for campaigns, launches, and social media.

PERSONALITY:
- Friendly, brief, creative
- Ask maximum ONE clarifying question before generating
- Keep replies short — this is Slack, not email
- Never ask multiple questions at once
- After generating, offer ONE specific adjustment option

WORKFLOW:
1. User describes what they need
2. If ONE critical thing is missing → ask for it
3. When ready → generate the right assets

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

BRAND SWITCHING:
If user says anything like "switch brand", "change brand", "use different brand":
- Set action to "switch_brand"
- Set message to ask which brand or confirm the switch

LIST / SHOW IMAGES (Bloom API — you do NOT have images in chat memory):
If the user asks to see recent images, gallery, thumbnails, "what did we generate", "show my generations", "list images", or similar:
- Set action to "list_images"
- Set generations to []
- Optional: list_images_limit (integer 5–25, default 15) if they ask for a specific count
- Set message to a short intro (e.g. "Here are your latest Bloom images for this brand:") — actual URLs will be filled in by the app after calling Bloom

CURRENT CONTEXT:
Brand: ${brandName}
Brand Session ID: ${brandSessionId}
Campaign history: ${JSON.stringify(campaignContext)}

RESPONSE FORMAT — return ONLY valid JSON, no markdown:
{
  "message": "your reply in Slack markdown (*bold*, _italic_, bullet points)",
  "action": "none | clarify | generate | generate_multiple | switch_brand | list_images",
  "generations": []
}

For action "generate": generations must be one object with prompt, aspect_ratio, variants, platform, label.
For action "generate_multiple": generations must be 2–6 such objects.
For action "list_images": generations must be [] and you may set "list_images_limit" (integer 5–25, optional).

Rules:
- action "none" or "clarify" or "list_images" or "switch_brand": generations must be []
- action "generate": generations has exactly 1 item
- action "generate_multiple": generations has 2-6 items, one per platform
- NEVER include anything outside the JSON object`;
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
      max_tokens: 1024,
      messages: [
        { role: 'system', content: buildSystemPrompt(brandName, brandSessionId, campaignContext) },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`OpenAI error: ${err?.error?.message || response.status}`);
  }

  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(text) as AgentDecision;
    if (!parsed.action) parsed.action = 'none';
    if (!parsed.generations) parsed.generations = [];
    const allowed = new Set(['none', 'clarify', 'generate', 'generate_multiple', 'switch_brand', 'list_images']);
    if (!allowed.has(parsed.action)) parsed.action = 'none';
    return parsed;
  } catch {
    return { message: text || 'Something went wrong. Try again.', action: 'none', generations: [] };
  }
}
