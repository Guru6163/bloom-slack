/**
 * Public base URL for this app (OAuth redirects, self-invoked job URLs).
 * Set NEXT_PUBLIC_APP_URL in production (e.g. https://bloom-slack.example.com).
 */
export function getAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  if (explicit) return explicit;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, '')}`;
  return 'http://localhost:3000';
}

export function getSlackOAuthRedirectUri(): string {
  return process.env.SLACK_REDIRECT_URI?.replace(/\/$/, '') ?? `${getAppBaseUrl()}/api/slack/oauth`;
}
