import { createSupabaseAdmin } from '@/lib/supabase-admin';
import { getWorkspaceBySetupToken } from '@/lib/db';
import { buildSetupHtml } from '@/lib/slack-setup-html';
import { getAppBaseUrl } from '@/lib/app-url';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  const supabase = createSupabaseAdmin();
  const workspace = await getWorkspaceBySetupToken(supabase, token);
  if (!workspace) {
    return new Response('Invalid or expired setup link', { status: 404 });
  }

  const isChangingBrandOnly = Boolean(
    workspace.setup_completed && String(workspace.bloom_api_key ?? '').trim(),
  );
  const html = buildSetupHtml(token, workspace, isChangingBrandOnly, getAppBaseUrl());
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
