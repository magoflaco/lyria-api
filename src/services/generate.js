// High-level generation flow:
//   prompt -> job -> stream -> clip ids -> poll until rendered -> clip metadata
//
// A single prompt normally yields TWO variations (clip A + clip B).

import { FlowClient } from '../client/flowClient.js';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a prompt through the Producer and collect the created clip ids by
 * consuming the job's SSE stream.
 *
 * @returns {Promise<{jobId,conversationId,title,clipIds,estimatedTime}>}
 */
export async function startGeneration(prompt, { client = new FlowClient(), ...opts } = {}) {
  const jobId = await client.sendMessage(prompt, opts);

  const clipIds = [];
  let conversationId = opts.conversationId || null;
  let title = null;
  let estimatedTime = null;

  const stream = await client.openJobStream(jobId);
  for await (const evt of stream) {
    if (evt.event === 'conversation_id') {
      try { conversationId = JSON.parse(evt.data).id; } catch {}
    } else if (evt.event === 'generated-title') {
      try { title = JSON.parse(evt.data).title; } catch {}
    } else if (evt.event === 'part') {
      let payload;
      try { payload = JSON.parse(evt.data); } catch { continue; }
      const part = payload.part;
      if (
        part &&
        part.part_kind === 'tool-return' &&
        part.tool_name === 'audio__create_song' &&
        part.content
      ) {
        const c = part.content;
        for (const id of [c.clip_id, c.clip_id_b]) {
          if (id && !clipIds.includes(id)) clipIds.push(id);
        }
        if (c.estimated_time != null) estimatedTime = c.estimated_time;
      }
    } else if (evt.event === 'final' || evt.event === 'error') {
      break;
    }
  }

  if (clipIds.length === 0) {
    throw new Error('Generation finished but no clips were produced (check prompt or credits).');
  }
  return { jobId, conversationId, title, clipIds, estimatedTime };
}

const CLIP_READY = (clip) =>
  clip &&
  clip.duration &&
  clip.duration.status === 'completed' &&
  (clip.wav_url || clip.audio_url);

/**
 * Poll /clips until every clip has finished rendering (audio urls available).
 * @returns {Promise<Object[]>} array of full clip objects.
 */
export async function waitForClips(clipIds, { client = new FlowClient(), timeoutMs = config.clipTimeoutMs, intervalMs = 3000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const clips = await client.getClips(clipIds);
    const list = clipIds.map((id) => clips[id]).filter(Boolean);
    const ready = list.filter(CLIP_READY);
    if (onProgress) onProgress({ ready: ready.length, total: clipIds.length });
    if (ready.length === clipIds.length && ready.length > 0) return ready;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for clips to render (${ready.length}/${clipIds.length} ready after ${Math.round(timeoutMs / 1000)}s).`
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Generate a song and wait until its clips are fully rendered.
 *
 * The Producer is an agent and decides on its own how many variations to make
 * (usually 1-2). To *guarantee* a caller-requested number of variations we
 * dispatch additional generations until we have enough distinct clips. Set
 * `variations` to 1 to accept whatever a single generation returns.
 *
 * @returns {Promise<{jobId,conversationId,title,clipIds,clips}>}
 */
export async function generateSong(prompt, opts = {}) {
  const client = opts.client || new FlowClient();
  const variations = Math.max(1, opts.variations ?? 2);
  const maxAttempts = opts.maxAttempts ?? variations + 2;

  const clipIds = [];
  let first = null;
  let attempts = 0;

  while (clipIds.length < variations && attempts < maxAttempts) {
    attempts++;
    const gen = await startGeneration(prompt, { ...opts, client });
    if (!first) first = gen;
    for (const id of gen.clipIds) if (!clipIds.includes(id)) clipIds.push(id);
    if (opts.onGeneration) opts.onGeneration({ attempt: attempts, have: clipIds.length, want: variations });
  }

  const wanted = clipIds.slice(0, variations);
  const clips = await waitForClips(wanted, { ...opts, client });
  return {
    jobId: first?.jobId,
    conversationId: first?.conversationId,
    title: first?.title,
    clipIds: wanted,
    clips,
  };
}
