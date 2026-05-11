import { createSupabaseAdmin } from '@/lib/supabase-admin';
import { fetchBrandsForApiKey } from '@/lib/slack-setup-brands';

export async function POST(req: Request) {
  const { token: tok } = (await req.json()) as { token?: string };
  if (!tok) return Response.json({ valid: false, brands: [] });

  const supabase = createSupabaseAdmin();
  const { data: ws } = await supabase
    .from('workspace_configs')
    .select('bloom_api_key')
    .eq('setup_token', tok)
    .maybeSingle();
  const key = (ws as { bloom_api_key?: string } | null)?.bloom_api_key;
  if (!key) return Response.json({ valid: false, brands: [] });
  return Response.json(await fetchBrandsForApiKey(key));
}
