import type { WorkspaceConfig } from './db';
import {
  getJob,
  getVariantPositionBias,
  getWorkspaceConfig,
  updateJob,
  upsertPromptTemplate,
} from './db';
import {
  brandRecordId,
  brandRecordName,
  editImage,
  generateImages,
  getBrand,
  getImageUrl,
  pollImagesUntilDone,
  resolveBrandSessionId,
} from './bloom';
import {
  buildErrorBlocks,
  buildProgressBlocks,
  buildRequestBlocks,
  buildResultBlocks,
  postMessage,
  updateMessage,
} from './slack';

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

async function resolveJobBloomBrand(
  apiKey: string,
  job: Record<string, unknown>,
  config: WorkspaceConfig,
): Promise<{ brandId: string; brandSessionId: string; displayName: string }> {
  const configBrandId = String(config.brand_id ?? '').trim();
  const jobBrandId = String(job.brand_id ?? '').trim();

  if (!jobBrandId || jobBrandId === configBrandId) {
    const brandSessionId = String(config.brand_session_id || config.brand_id || '').trim();
    if (!brandSessionId) {
      throw new Error(
        'Workspace Bloom brand is not fully configured (missing session). Ask an admin to run `/bloom-gen setup`.',
      );
    }
    const displayName = String(config.brand_name ?? '').trim() || 'Bloom';
    return { brandId: configBrandId || jobBrandId, brandSessionId, displayName };
  }

  const raw = await getBrand(apiKey, jobBrandId);
  const brand = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!brand) throw new Error(`Bloom brand not found for this job (ID: \`${jobBrandId}\`).`);
  const id = brandRecordId(brand) || jobBrandId;
  const session = resolveBrandSessionId(brand).trim();
  const brandSessionId = session || id;
  if (!brandSessionId) {
    throw new Error(`Could not resolve Bloom session for brand \`${jobBrandId}\`.`);
  }
  return {
    brandId: id,
    brandSessionId,
    displayName: brandRecordName(brand),
  };
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

export async function handleRunGenerationRequest(body: {
  jobId?: string;
  intent?: string;
  imageIndex?: number;
  baseImageId?: string;
}): Promise<Response> {
  let jobId: string;
  let intent = '';
  let imageIndex = 0;
  let baseImageId = '';
  try {
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
  const userId = String(job.user_id ?? '');
  const channelId = String(job.channel_id ?? '');
  const aspectRatio = String(job.aspect_ratio ?? '16:9');
  const variantCount = Number(job.variants ?? 2);
  const slackThreadTs =
    job.thread_ts != null && String(job.thread_ts).trim() !== ''
      ? String(job.thread_ts).trim()
      : undefined;
  let liveMessageTs = messageTs;

  try {
    const bloomApiKey = config.bloom_api_key || '';
    if (!bloomApiKey) throw new Error('No Bloom API key configured');

    const { brandId, brandSessionId, displayName } = await resolveJobBloomBrand(
      bloomApiKey,
      job as Record<string, unknown>,
      config,
    );

    let progressTs = liveMessageTs;
    if (!progressTs) {
      const requestMsg = await postMessage(
        config.bot_token,
        channelId,
        buildRequestBlocks(prompt, aspectRatio, userId),
        slackThreadTs,
      );
      const requestTs = String(requestMsg.ts ?? '');
      const queuedMsg = await postMessage(
        config.bot_token,
        channelId,
        buildProgressBlocks(prompt, aspectRatio, userId, 'queued'),
        requestTs || slackThreadTs,
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
      slackThreadTs,
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
      await updateJob(jobId, {
        image_ids: imageIds,
        image_urls: imageUrls,
        status: 'completed',
        brand_name: displayName,
      });
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
        slackThreadTs,
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
        brand_name: displayName,
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
      buildResultBlocks(prompt, aspectRatio, imageUrls, jobId, 0, displayName),
      slackThreadTs,
    );

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(jobId, { status: 'failed', error: message });
    if (liveMessageTs) {
      try {
        await updateMessage(
          config.bot_token,
          channelId,
          liveMessageTs,
          buildErrorBlocks(prompt, message, jobId),
          slackThreadTs,
        );
      } catch (slackErr) {
        console.error('run-generation: failed to post error to Slack', slackErr);
      }
    }
    return new Response('Error', { status: 500 });
  }
}
