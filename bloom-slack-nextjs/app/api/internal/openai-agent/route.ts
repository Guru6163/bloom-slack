import { isAuthorizedInternalRequest } from '@/lib/internal-auth';
import { handleOpenAiAgentRequest } from '@/lib/openai-agent-handler';

export async function POST(req: Request) {
  if (!isAuthorizedInternalRequest(req)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json()) as {
    teamId?: string;
    channelId?: string;
    userId?: string;
    threadTs?: string | null;
    thread_ts?: string | null;
    messageTs?: string;
    text?: string;
  };
  return handleOpenAiAgentRequest(body);
}
