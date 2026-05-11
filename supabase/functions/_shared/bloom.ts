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

export async function listImages(
  apiKey: string,
  limit = 10,
  opts?: { brandSessionId?: string; source?: string; status?: string },
): Promise<unknown[]> {
  const safeLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 10));
  const params = new URLSearchParams({
    limit: String(safeLimit),
    includeUrls: 'true',
  });
  if (opts?.brandSessionId) params.set('brandSessionId', opts.brandSessionId);
  if (opts?.source) params.set('source', opts.source);
  if (opts?.status) params.set('status', opts.status);
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

export function brandRecordId(brand: Record<string, unknown>): string {
  return String(brand.id ?? brand.brandId ?? brand.brand_id ?? '').trim();
}

export function brandRecordName(brand: Record<string, unknown>): string {
  return String(brand.name ?? brand.brandName ?? brand.brand_name ?? 'Unknown').trim() || 'Unknown';
}

function normalizeBrandQuery(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Slack mrkdwn: directory of brands (same shape as `/bloom-gen brands`). */
export function formatSlackBrandsList(
  brands: unknown[],
  currentBrandId?: string,
  maxRows = 20,
): string {
  const lines = brands
    .filter((item) => !!item && typeof item === 'object')
    .slice(0, maxRows)
    .map((item) => {
      const brand = item as Record<string, unknown>;
      const id = brandRecordId(brand);
      const name = brandRecordName(brand);
      const cur = currentBrandId && id && id === currentBrandId ? ' _(current)_' : '';
      return `• ${name} (\`${id || 'N/A'}\`)${cur}`;
    });
  if (!lines.length) return 'No brands found in your Bloom account.';
  return `*Available Bloom Brands (${lines.length})*\n${lines.join('\n')}`;
}

export type PickBrandForWorkspaceResult =
  | { ok: true; id: string; name: string; sessionId: string }
  | { ok: false; message: string };

/** Resolve a brand by explicit Bloom ID or by fuzzy name against `listBrands`. */
export async function pickBrandForWorkspace(
  apiKey: string,
  options: { brandId?: string; brandNameHint?: string },
): Promise<PickBrandForWorkspaceResult> {
  const idIn = options.brandId?.trim() ?? '';
  const hintIn = options.brandNameHint?.trim() ?? '';

  if (idIn) {
    try {
      const raw = await getBrand(apiKey, idIn);
      const brand = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      if (!brand) return { ok: false, message: `Brand not found for ID \`${idIn}\`.` };
      const id = brandRecordId(brand) || idIn;
      const name = brandRecordName(brand);
      const sessionId = resolveBrandSessionId(brand);
      if (!id) return { ok: false, message: 'Could not resolve brand ID from Bloom response.' };
      return { ok: true, id, name, sessionId };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Unable to load brand' };
    }
  }

  if (!hintIn) {
    return {
      ok: false,
      message: 'Please specify a brand ID or name (e.g. "switch to Acme" or paste a brand ID).',
    };
  }

  let brands: unknown[];
  try {
    brands = await listBrands(apiKey);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Unable to list brands' };
  }

  const records = brands.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
  const withIds = records.filter((b) => brandRecordId(b));
  if (!withIds.length) {
    return { ok: false, message: 'No brands found in this Bloom account.' };
  }

  const nh = normalizeBrandQuery(hintIn);
  const exact = withIds.filter((b) => normalizeBrandQuery(brandRecordName(b)) === nh);
  if (exact.length === 1) {
    const brand = exact[0]!;
    const id = brandRecordId(brand);
    const name = brandRecordName(brand);
    const sessionId = resolveBrandSessionId(brand);
    return { ok: true, id, name, sessionId };
  }
  if (exact.length > 1) {
    const lines = exact.slice(0, 8).map((b) => `• ${brandRecordName(b)} (\`${brandRecordId(b)}\`)`);
    return {
      ok: false,
      message: `Several brands matched "${hintIn}". Reply with the exact ID:\n${lines.join('\n')}`,
    };
  }

  const partial = withIds.filter((b) => {
    const n = normalizeBrandQuery(brandRecordName(b));
    return n.includes(nh) || nh.includes(n);
  });
  if (partial.length === 1) {
    const brand = partial[0]!;
    const id = brandRecordId(brand);
    const name = brandRecordName(brand);
    const sessionId = resolveBrandSessionId(brand);
    return { ok: true, id, name, sessionId };
  }
  if (partial.length > 1) {
    const lines = partial.slice(0, 8).map((b) => `• ${brandRecordName(b)} (\`${brandRecordId(b)}\`)`);
    return {
      ok: false,
      message: `Several brands matched "${hintIn}". Reply with the exact ID:\n${lines.join('\n')}`,
    };
  }

  return {
    ok: false,
    message:
      `No brand matched "${hintIn}". Ask me to *list brands* or run \`/bloom-gen brands\` to see IDs.`,
  };
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
  if (!imageIds.length) return [];

  // Single 120s long-poll can exceed Edge run limits or stall; use shorter waits in a loop.
  const deadline = Date.now() + 100_000;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const budgetSec = Math.max(5, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
    const params = new URLSearchParams({
      ids: imageIds.join(','),
      wait: 'true',
      timeout: String(budgetSec),
      includeUrls: 'true',
    });

    try {
      const data = await fetchBloom(`/images?${params.toString()}`, apiKey) as Record<string, unknown>;
      const images = extractCollection(data, 'images');
      const byId = new Map<string, Record<string, unknown>>();
      for (const img of images) {
        if (!img || typeof img !== 'object') continue;
        const row = img as Record<string, unknown>;
        const id = String(row.id ?? row.imageId ?? '').trim();
        if (id) byId.set(id, row);
      }

      const ordered: unknown[] = [];
      let allReady = true;
      for (const id of imageIds) {
        const row = byId.get(id);
        const url = row ? getImageUrl(row) : '';
        const status = String(row?.status ?? '').toLowerCase();
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
          const detail = String(row?.error ?? row?.failureReason ?? status);
          throw new Error(`Bloom image failed (${id}): ${detail}`);
        }
        if (url) ordered.push(row);
        else allReady = false;
      }

      if (allReady && ordered.length === imageIds.length) return ordered;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message.startsWith('Bloom image failed')) throw err;
      lastError = err;
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw lastError ?? new Error('Timed out waiting for Bloom images (no URL after polling)');
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
