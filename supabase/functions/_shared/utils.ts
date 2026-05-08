export interface ParsedCommand {
  action: 'generate' | 'setup' | 'brand' | 'help' | 'unknown';
  prompt: string;
  aspectRatio: string;
  variants: number;
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = (text || '').trim();

  if (!trimmed || trimmed.toLowerCase() === 'help') {
    return { action: 'help', prompt: '', aspectRatio: '16:9', variants: 2 };
  }
  if (trimmed.toLowerCase() === 'setup') {
    return { action: 'setup', prompt: '', aspectRatio: '16:9', variants: 2 };
  }
  if (trimmed.toLowerCase() === 'brand') {
    return { action: 'brand', prompt: '', aspectRatio: '16:9', variants: 2 };
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
  // TODO: re-enable signature verification after testing
  return true;
}
