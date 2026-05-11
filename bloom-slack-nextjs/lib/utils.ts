import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ParsedCommand {
  action: 'generate' | 'setup' | 'brand' | 'brands' | 'images' | 'image' | 'credits' | 'workspaces' | 'help' | 'unknown';
  prompt: string;
  aspectRatio: string;
  variants: number;
  setupApiKey?: string;
  setupBrandId?: string;
  entityId?: string;
  limit?: number;
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = (text || '').trim();
  const defaultParsed: ParsedCommand = { action: 'help', prompt: '', aspectRatio: '16:9', variants: 2 };
  const lower = trimmed.toLowerCase();

  if (!trimmed || lower === 'help') {
    return defaultParsed;
  }
  if (lower.startsWith('setup')) {
    const setupText = trimmed.slice(5).trim();
    const [apiKey = '', brandId = ''] = setupText.split(/\s+/).filter(Boolean);
    return {
      action: 'setup',
      prompt: '',
      aspectRatio: '16:9',
      variants: 2,
      setupApiKey: apiKey,
      setupBrandId: brandId,
    };
  }
  if (lower === 'brand') {
    return { ...defaultParsed, action: 'brand' };
  }
  if (lower.startsWith('brand ')) {
    return { ...defaultParsed, action: 'brand', entityId: trimmed.split(/\s+/).slice(1).join(' ') };
  }
  if (lower === 'brands') {
    return { ...defaultParsed, action: 'brands' };
  }
  if (lower === 'credits') {
    return { ...defaultParsed, action: 'credits' };
  }
  if (lower === 'workspaces') {
    return { ...defaultParsed, action: 'workspaces' };
  }
  if (lower === 'images') {
    return { ...defaultParsed, action: 'images', limit: 10 };
  }
  if (lower.startsWith('images ')) {
    const requestedLimit = Number.parseInt(trimmed.split(/\s+/)[1] || '', 10);
    const safeLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(25, requestedLimit)) : 10;
    return { ...defaultParsed, action: 'images', limit: safeLimit };
  }
  if (lower.startsWith('image ')) {
    return { ...defaultParsed, action: 'image', entityId: trimmed.split(/\s+/).slice(1).join(' ') };
  }

  const ratioMap: Record<string, string> = {
    '1:1': '1:1',
    '16:9': '16:9',
    '9:16': '9:16',
    '4:5': '4:5',
    'square': '1:1',
    'landscape': '16:9',
    'portrait': '9:16',
    'story': '9:16',
    'wide': '16:9',
  };

  let promptText = trimmed;
  if (promptText.toLowerCase().startsWith('generate ')) {
    promptText = promptText.slice(9);
  }

  let aspectRatio = '16:9';
  const words = promptText.split(/\s+/).filter(Boolean);
  const lastWord = words.length > 0 ? words[words.length - 1].toLowerCase() : '';
  if (lastWord && ratioMap[lastWord]) {
    aspectRatio = ratioMap[lastWord];
    promptText = words.slice(0, -1).join(' ');
  }

  return { action: 'generate', prompt: promptText.trim(), aspectRatio, variants: 2 };
}

export async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true;

  const sig = req.headers.get('x-slack-signature');
  const ts = req.headers.get('x-slack-request-timestamp');
  if (!sig || !ts) return false;

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(ts) < fiveMinutesAgo) return false;

  const base = `v0:${ts}:${body}`;
  const hmac = createHmac('sha256', signingSecret).update(base).digest('hex');
  const expected = `v0=${hmac}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}
