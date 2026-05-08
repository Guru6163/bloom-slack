import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { getJob, getWorkspaceConfig, updateJob } from '../_shared/db.ts';
import { generateImages, getImageUrl, pollImagesUntilDone } from '../_shared/bloom.ts';
import { buildErrorBlocks, buildResultBlocks, updateMessage } from '../_shared/slack.ts';

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let jobId: string;
  try {
    const body = await req.json() as { jobId?: string };
    jobId = String(body.jobId ?? '');
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

  try {
    const bloomApiKey = config.bloom_api_key || Deno.env.get('BLOOM_API_KEY') || '';
    if (!bloomApiKey) throw new Error('No Bloom API key configured');
    const brandSessionId = config.brand_session_id || config.brand_id;

    const imageIds = await generateImages(
      bloomApiKey,
      brandSessionId,
      prompt,
      String(job.aspect_ratio ?? '16:9'),
      Number(job.variants ?? 2),
    );
    await updateJob(jobId, { image_ids: imageIds, status: 'generating' });

    const images = await pollImagesUntilDone(bloomApiKey, imageIds);
    const imageUrls = images
      .map((img) => getImageUrl((img ?? {}) as Record<string, unknown>))
      .filter(Boolean);

    if (!imageUrls.length) throw new Error('No image URLs returned');

    await updateJob(jobId, {
      status: 'completed',
      image_urls: imageUrls,
      completed_at: new Date().toISOString(),
    });

    await updateMessage(
      config.bot_token,
      String(job.channel_id ?? ''),
      messageTs,
      buildResultBlocks(
        prompt,
        String(job.aspect_ratio ?? '16:9'),
        imageUrls,
        jobId,
        0,
        config.brand_name,
      ),
    );

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(jobId, { status: 'failed', error: message });
    if (messageTs) {
      await updateMessage(
        config.bot_token,
        String(job.channel_id ?? ''),
        messageTs,
        buildErrorBlocks(prompt, message, jobId),
      );
    }
    return new Response('Error', { status: 500 });
  }
});
