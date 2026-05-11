import { isAuthorizedInternalRequest } from '@/lib/internal-auth';
import { handleRunGenerationRequest } from '@/lib/run-generation-handler';

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!isAuthorizedInternalRequest(req)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = (await req.json()) as {
    jobId?: string;
    intent?: string;
    imageIndex?: number;
    baseImageId?: string;
  };
  return handleRunGenerationRequest(body);
}
