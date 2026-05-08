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
  return extractCollection(data, 'brands');
}

export async function getBrand(apiKey: string, brandId: string): Promise<unknown> {
  const data = await fetchBloom(`/brands/${brandId}`, apiKey) as Record<string, unknown>;
  return extractEntity(data);
}

export async function listImages(apiKey: string, limit = 10): Promise<unknown[]> {
  const safeLimit = Math.max(1, Math.min(25, Number.isFinite(limit) ? limit : 10));
  const params = new URLSearchParams({
    limit: String(safeLimit),
    includeUrls: 'true',
  });
  const data = await fetchBloom(`/images?${params.toString()}`, apiKey) as Record<string, unknown>;
  return extractCollection(data, 'images');
}

export async function getImage(apiKey: string, imageId: string): Promise<unknown | null> {
  const data = await fetchBloom(`/images/${imageId}`, apiKey) as Record<string, unknown>;
  return extractEntity(data);
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
  const referenceImageIds = await pickReferenceImageIds(apiKey, brandSessionId);
  const data = await fetchBloom('/images/generations', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      brandSessionId,
      aspectRatio,
      imageSize: '2K',
      model: 'fast',
      variantCount: variants,
      referenceImageIds,
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
  return listImagesByQuery(apiKey, params, true);
}

export function getImageUrl(image: Record<string, unknown>): string {
  const url = String(image?.imageUrl ?? image?.url ?? '');
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://www.trybloom.ai${url}`;
  return url;
}

export async function editImage(
  apiKey: string,
  imageId: string,
  instruction: string,
  brandSessionId?: string,
): Promise<unknown> {
  return fetchBloom(`/images/${imageId}/edit`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      prompt: instruction,
      ...(brandSessionId ? { brandSessionId } : {}),
    }),
  });
}

export async function getCredits(apiKey: string): Promise<{ balance: number | null; unlimited: boolean | null }> {
  const data = await fetchBloom('/credits', apiKey) as Record<string, unknown>;
  const entity = extractEntity(data);
  const record = entity && typeof entity === 'object' ? entity as Record<string, unknown> : {};
  return {
    balance: toNumberOrNull(record.balance),
    unlimited: toBooleanOrNull(record.unlimited),
  };
}

export async function listWorkspaces(apiKey: string): Promise<unknown[]> {
  const data = await fetchBloom('/workspaces', apiKey) as Record<string, unknown>;
  return extractCollection(data, 'workspaces');
}

async function listImagesByQuery(
  apiKey: string,
  params: URLSearchParams,
  throwOnInvalid = false,
): Promise<unknown[]> {
  const data = await fetchBloom(`/images?${params.toString()}`, apiKey) as Record<string, unknown>;
  const images = extractCollection(data, 'images');
  if (images.length > 0) return images;
  if (throwOnInvalid) throw new Error('Invalid images response');
  return [];
}

async function pickReferenceImageIds(apiKey: string, brandSessionId: string): Promise<string[]> {
  const limit = 25;
  const baseParams = new URLSearchParams({
    limit: String(limit),
    includeUrls: 'false',
  });

  // Best-effort brand scoping: Bloom payloads vary by account/version.
  const scopedCandidates = await firstNonEmptyImageSet(apiKey, baseParams, brandSessionId);

  const candidates = scopedCandidates.length > 0
    ? scopedCandidates
    : await listImagesByQuery(apiKey, baseParams);

  const sorted = candidates
    .map((image) => image as Record<string, unknown>)
    .map((image) => ({
      id: resolveImageId(image),
      createdAt: resolveCreatedAt(image),
    }))
    .filter((row): row is { id: string; createdAt: number } => Boolean(row.id))
    .sort((a, b) => b.createdAt - a.createdAt);

  return Array.from(new Set(sorted.map((row) => row.id))).slice(0, 3);
}

async function firstNonEmptyImageSet(
  apiKey: string,
  baseParams: URLSearchParams,
  brandSessionId: string,
): Promise<unknown[]> {
  const scopedKeys = ['brandSessionId', 'brand_session_id', 'sessionId'];
  for (const key of scopedKeys) {
    const images = await listImagesByQuery(apiKey, withParam(baseParams, key, brandSessionId));
    if (images.length > 0) return images;
  }
  return [];
}

function withParam(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value);
  return next;
}

function resolveImageId(image: Record<string, unknown>): string {
  return String(image.id ?? image.imageId ?? '').trim();
}

function resolveCreatedAt(image: Record<string, unknown>): number {
  const raw = image.createdAt ?? image.created_at ?? image.updatedAt ?? image.updated_at;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCollection(payload: Record<string, unknown>, key: string): unknown[] {
  const data = payload?.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record[key])) return record[key] as unknown[];
    if (Array.isArray(data)) return data as unknown[];
    return [];
  }
  if (Array.isArray(payload[key])) return payload[key] as unknown[];
  if (Array.isArray(payload)) return payload as unknown[];
  return [];
}

function extractEntity(payload: Record<string, unknown>): unknown | null {
  const data = payload?.data;
  if (data && typeof data === 'object') return data;
  if (payload && typeof payload === 'object') return payload;
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
