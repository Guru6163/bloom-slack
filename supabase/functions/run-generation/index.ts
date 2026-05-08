import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import {
  getJob,
  getVariantPositionBias,
  getWorkspaceConfig,
  updateJob,
  upsertPromptTemplate,
} from '../_shared/db.ts';
import { editImage, generateImages, getImageUrl, pollImagesUntilDone } from '../_shared/bloom.ts';
import {
  buildErrorBlocks,
  buildProgressBlocks,
  buildRequestBlocks,
  buildResultBlocks,
  postMessage,
  updateMessage,
} from '../_shared/slack.ts';

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let jobId: string;
  let intent = '';
  let imageIndex = 0;
  let baseImageId = '';
  try {
    const body = await req.json() as {
      jobId?: string;
      intent?: string;
      imageIndex?: number;
      baseImageId?: string;
    };
    jobId = String(body.jobId ?? '');
    intent = String(body.intent ?? '');
    imageIndex = Number(body.imageIndex ?? 0);
    baseImageId = String(body.baseImageId ?? '');
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!jobId) return new Response('Missing jobId', { status: 400 });

  const job = await getJob(jobId);
  if (!job) return new Response('Job not found', { status: 404 });

  const config = await getWorkspaceConfig(String(job.team_id ?? ''));
  if (!config) return new Response('Config not found', { status: 404 });

  const prompt = String(job.prompt ?? '');
  const messageTs = String(job.message_ts ?? '');
  const teamId = String(job.team_id ?? '');
  const brandId = String(job.brand_id ?? config.brand_id ?? '');
  const userId = String(job.user_id ?? '');
  const channelId = String(job.channel_id ?? '');
  const aspectRatio = String(job.aspect_ratio ?? '16:9');
  const variantCount = Number(job.variants ?? 2);
  let liveMessageTs = messageTs;

  try {
    const bloomApiKey = config.bloom_api_key || '';
    if (!bloomApiKey) throw new Error('No Bloom API key configured');
    const brandSessionId = config.brand_session_id || config.brand_id;

    let progressTs = liveMessageTs;
    if (!progressTs) {
      const requestMsg = await postMessage(
        config.bot_token,
        channelId,
        buildRequestBlocks(prompt, aspectRatio, userId),
      );
      const requestTs = String(requestMsg.ts ?? '');
      const queuedMsg = await postMessage(
        config.bot_token,
        channelId,
        buildProgressBlocks(prompt, aspectRatio, userId, 'queued'),
        requestTs || undefined,
      );
      progressTs = String(queuedMsg.ts ?? requestTs);
      await updateJob(jobId, { message_ts: progressTs });
    }
    liveMessageTs = progressTs;

    await updateMessage(
      config.bot_token,
      channelId,
      progressTs,
      buildProgressBlocks(prompt, aspectRatio, userId, 'generating'),
    );

    let imageIds: string[] = [];
    let imageUrls: string[] = [];

    if (intent && baseImageId) {
      const instruction = resolveIntentInstruction(intent, prompt);
      const editResponse = await editImage(bloomApiKey, baseImageId, instruction, brandSessionId);
      const editedIds = extractImageIds(editResponse);
      if (!editedIds.length) throw new Error('Edit did not return image IDs');
      const editedImages = await pollImagesUntilDone(bloomApiKey, editedIds);
      const firstUrl = getImageUrl((editedImages[0] ?? {}) as Record<string, unknown>);
      if (!firstUrl) throw new Error('Edited image URL not available');
      imageIds = [...(((job.image_ids as string[] | null) ?? []))];
      imageUrls = [...(((job.image_urls as string[] | null) ?? []))];
      imageIds[imageIndex] = editedIds[0];
      imageUrls[imageIndex] = firstUrl;
      await updateJob(jobId, { image_ids: imageIds, image_urls: imageUrls, status: 'completed' });
    } else {
      imageIds = await generateImages(
        bloomApiKey,
        brandSessionId,
        prompt,
        aspectRatio,
        variantCount,
      );
      await updateJob(jobId, { image_ids: imageIds, status: 'generating' });

      await updateMessage(
        config.bot_token,
        channelId,
        progressTs,
        buildProgressBlocks(prompt, aspectRatio, userId, 'finalizing'),
      );

      const images = await pollImagesUntilDone(bloomApiKey, imageIds);
      const rawUrls = images
        .map((img) => getImageUrl((img ?? {}) as Record<string, unknown>))
        .filter(Boolean);

      if (!rawUrls.length) throw new Error('No image URLs returned');
      const ordered = reorderByFeedbackBias(imageIds, rawUrls, await getVariantPositionBias(teamId, brandId));
      imageIds = ordered.imageIds;
      imageUrls = ordered.imageUrls;

      await updateJob(jobId, {
        status: 'completed',
        image_ids: imageIds,
        image_urls: imageUrls,
        completed_at: new Date().toISOString(),
      });
      await upsertPromptTemplate({
        team_id: teamId,
        brand_id: brandId,
        prompt,
        aspect_ratio: aspectRatio,
        variants: variantCount,
      });
    }

    await updateMessage(
      config.bot_token,
      channelId,
      progressTs,
      buildResultBlocks(prompt, aspectRatio, imageUrls, jobId, 0, config.brand_name),
    );

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(jobId, { status: 'failed', error: message });
    if (liveMessageTs) {
      await updateMessage(
        config.bot_token,
        channelId,
        liveMessageTs,
        buildErrorBlocks(prompt, message, jobId),
      );
    }
    return new Response('Error', { status: 500 });
  }
});

function extractImageIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const data = p.data as Record<string, unknown> | undefined;
  const ids = data?.ids ?? p.ids ?? data?.imageIds;
  if (Array.isArray(ids)) return ids.map((id) => String(id)).filter(Boolean);
  const single = data?.id ?? p.id;
  return single ? [String(single)] : [];
}

function resolveIntentInstruction(intent: string, prompt: string): string {
  const map: Record<string, string> = {
    premium: 'Make this image feel premium and high-end with cleaner lighting and sophisticated styling.',
    brighter: 'Increase brightness, clarity, and color vibrancy while keeping the same composition.',
    product: 'Shift focus to the product with cleaner background and stronger product detail emphasis.',
    holiday: 'Add a tasteful seasonal holiday mood with festive but brand-safe styling.',
  };
  return `${map[intent] ?? 'Refine this image while preserving the core composition.'} Prompt context: ${prompt}`;
}

function reorderByFeedbackBias(
  imageIds: string[],
  imageUrls: string[],
  bias: Map<number, number>,
): { imageIds: string[]; imageUrls: string[] } {
  const rows = imageUrls.map((url, idx) => ({
    id: imageIds[idx] ?? '',
    url,
    idx,
    score: bias.get(idx) ?? 0,
  }));
  rows.sort((a, b) => b.score - a.score);
  return {
    imageIds: rows.map((r) => r.id),
    imageUrls: rows.map((r) => r.url),
  };
}
