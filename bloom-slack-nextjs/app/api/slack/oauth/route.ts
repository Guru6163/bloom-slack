import { getAppBaseUrl, getSlackOAuthRedirectUri } from '@/lib/app-url';
import { handleSlackOAuth } from '@/lib/slack-oauth';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('code') || url.searchParams.get('error')) {
    return handleSlackOAuth(req.url);
  }

  const redirectUri = getSlackOAuthRedirectUri();
  const installUrl = `${getAppBaseUrl()}/api/slack/install`;
  return new Response(
    [
      'Slack → OAuth & Permissions → Redirect URLs → Add this URL (exact match, character-for-character):',
      '',
      redirectUri,
      '',
      `Then start install: ${installUrl}`,
      '',
      'If ngrok restarts, its hostname changes — update Redirect URLs and NEXT_PUBLIC_APP_URL / SLACK_REDIRECT_URI to match.',
    ].join('\n'),
    {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    },
  );
}
