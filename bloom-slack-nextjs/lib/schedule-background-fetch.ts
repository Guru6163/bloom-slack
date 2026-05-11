import { after } from 'next/server';

/**
 * Run a POST fetch after the HTTP response is sent. Required on Vercel/serverless:
 * unawaited `fetch()` from a route often never runs once the handler returns 200.
 */
export function scheduleBackgroundFetch(
  label: string,
  url: string,
  init: RequestInit,
): void {
  after(async () => {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[${label}] ${res.status}`, text.slice(0, 800));
      }
    } catch (err) {
      console.error(`[${label}]`, err);
    }
  });
}
