import { fetchBrandsForApiKey } from '@/lib/slack-setup-brands';

export async function POST(req: Request) {
  const { api_key } = (await req.json()) as { api_key?: string };
  if (!api_key) return Response.json({ valid: false, brands: [] });
  const { valid, brands } = await fetchBrandsForApiKey(api_key);
  return Response.json({ valid, brands });
}
