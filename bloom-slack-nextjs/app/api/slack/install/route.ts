import { NextResponse } from 'next/server';
import { getSlackOAuthRedirectUri } from '@/lib/app-url';

/** Bot scopes this app needs (must match what you enable in Slack app settings). */
const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'chat:write',
  'commands',
  'groups:history',
  'im:write',
].join(',');

/**
 * Open this URL in a browser while `next dev` + ngrok are running to start Slack OAuth.
 * Completing the flow inserts a row into `workspace_configs`.
 */
export function GET() {
  const clientId = process.env.SLACK_CLIENT_ID?.trim();
  if (!clientId) {
    return new NextResponse('Missing SLACK_CLIENT_ID in environment.', { status: 500 });
  }

  const redirectUri = getSlackOAuthRedirectUri();
  const authorize = new URL('https://slack.com/oauth/v2/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('scope', SLACK_BOT_SCOPES);
  authorize.searchParams.set('redirect_uri', redirectUri);

  return NextResponse.redirect(authorize.toString(), 302);
}
