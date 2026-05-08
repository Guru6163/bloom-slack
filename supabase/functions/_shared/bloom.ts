const BLOOM_BASE = 'https://www.trybloom.ai/api/v1';

async function fetchBloom(path: string, apiKey: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BLOOM_BASE}${path}`, {
    ...options,
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err?.error?.message || `Bloom API ${res.status}`);
  }
  return res.json();
}

export async function validateKey(apiKey: string): Promise<boolean> {
  try {
    await fetchBloom('/brands', apiKey);
    return true;
  } catch {
    return false;
  }
}

export async function listBrands(apiKey: string): Promise<unknown[]> {
  const data = await fetchBloom('/brands?limit=50', apiKey) as Record<string, unknown>;
  const d = data?.data as Record<string, unknown> | undefined;
  if (Array.isArray(d?.brands)) return d.brands as unknown[];
  if (Array.isArray(d)) return d as unknown[];
  if (Array.isArray(data)) return data as unknown[];
  return [];
}

export async function getBrand(apiKey: string, brandId: string): Promise<unknown> {
  return fetchBloom(`/brands/${brandId}`, apiKey);
}

export function resolveBrandSessionId(brand: Record<string, unknown>): string {
  return String(
    brand?.brandSessionId ??
      brand?.brand_session_id ??
      brand?.sessionId ??
      brand?.id ??
      '',
  );
}

export async function generateImages(
  apiKey: string,
  brandSessionId: string,
  prompt: string,
  aspectRatio: string,
  variants: number,
): Promise<string[]> {
  const data = await fetchBloom('/images/generations', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      brandSessionId,
      aspectRatio,
      imageSize: '2K',
      model: 'fast',
      variantCount: variants,
      referenceImageIds: [],
    }),
  }) as { data?: { ids?: unknown } };
  const ids = data?.data?.ids;
  if (!Array.isArray(ids)) throw new Error('Invalid generation response');
  return ids as string[];
}

export async function pollImagesUntilDone(apiKey: string, imageIds: string[]): Promise<unknown[]> {
  const params = new URLSearchParams({
    ids: imageIds.join(','),
    wait: 'true',
    timeout: '120',
    includeUrls: 'true',
  });
  const data = await fetchBloom(`/images?${params.toString()}`, apiKey) as {
    data?: { images?: unknown };
  };
  const images = data?.data?.images;
  if (!Array.isArray(images)) throw new Error('Invalid images response');
  return images as unknown[];
}

export function getImageUrl(image: Record<string, unknown>): string {
  const url = String(image?.imageUrl ?? image?.url ?? '');
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://www.trybloom.ai${url}`;
  return url;
}

export async function editImage(apiKey: string, imageId: string, instruction: string): Promise<unknown> {
  return fetchBloom(`/images/${imageId}/edit`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  });
}
