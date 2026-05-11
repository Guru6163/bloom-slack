export async function fetchBrandsForApiKey(apiKey: string): Promise<{ valid: boolean; brands: unknown[] }> {
  try {
    const res = await fetch('https://www.trybloom.ai/api/v1/brands?limit=50', {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { valid: false, brands: [] };
    const data = await res.json() as Record<string, unknown>;
    const brands = (data?.data as Record<string, unknown> | undefined)?.brands ??
      data?.data ??
      data?.brands ??
      [];
    const list = Array.isArray(brands) ? brands : [];
    return { valid: true, brands: list };
  } catch {
    return { valid: false, brands: [] };
  }
}
