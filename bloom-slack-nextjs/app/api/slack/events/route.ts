import { verifySlackSignature } from '@/lib/utils';
import { handleSlackEventsPost } from '@/lib/slack-events-handler';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('test') === '1') {
    return Response.json({ ok: true, message: 'Function is live' });
  }
  return new Response('OK', { status: 200 });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!(await verifySlackSignature(req, rawBody))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const contentType = req.headers.get('content-type') || '';
  return handleSlackEventsPost(req.url, rawBody, contentType);
}
