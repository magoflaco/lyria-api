// High-level generation & editing flow:
//   message -> job -> SSE stream -> clip ids -> poll until rendered -> metadata
//
// A single prompt yields whatever the Producer decides (usually 1-2 variations);
// we return every clip it produces. Editing (remix / cover / extend / variation
// and free-form tweaks) is just another message in the same conversation, with
// the target clip passed as `currentSongId` — exactly how the Flow Music chat
// works.

import { FlowClient } from '../client/flowClient.js';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tool calls that yield playable clips. Generation uses audio__create_song;
// edits (remix/cover/extend/variation) resolve through audio__render_edit.
const CLIP_TOOLS = new Set([
  'audio__create_song',
  'audio__modify_song',
  'audio__render_edit',
]);

// Pull the produced clip ids out of a tool-return `content` object. Handles
// both shapes seen in the wild:
//   create_song: { clip_id, clip_id_b }
//   render_edit: { clip_outputs: [ { node_id, clip_id, title } ] }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function extractClipIds(content) {
  const ids = [];
  if (!content || typeof content !== 'object') return ids;
  // top-level *clip_id* fields (create_song)
  for (const [key, val] of Object.entries(content)) {
    if (typeof val === 'string' && /clip_id/i.test(key) && UUID_RE.test(val)) ids.push(val);
  }
  // nested clip_outputs[] (render_edit — the edited results)
  if (Array.isArray(content.clip_outputs)) {
    for (const out of content.clip_outputs) {
      if (out && typeof out.clip_id === 'string' && UUID_RE.test(out.clip_id)) ids.push(out.clip_id);
    }
  }
  return ids;
}

/**
 * Send one message to the Producer and consume its job stream, collecting the
 * clips it creates. Works for both fresh generations and edits.
 *
 * @param {string} prompt        natural-language instruction
 * @param {object} opts
 * @param {string} [opts.conversationId]  continue an existing conversation (edit)
 * @param {string} [opts.currentSongId]   clip the edit should act on
 * @returns {Promise<{jobId,conversationId,title,clipIds,estimatedTime}>}
 */
export async function sendProducerMessage(prompt, { client = new FlowClient(), ...opts } = {}) {
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
      if (part && part.part_kind === 'tool-return' && CLIP_TOOLS.has(part.tool_name) && part.content) {
        const c = part.content;
        for (const id of extractClipIds(c)) {
          if (!clipIds.includes(id)) clipIds.push(id);
        }
        if (c.estimated_time != null) estimatedTime = c.estimated_time;
      }
    } else if (evt.event === 'final' || evt.event === 'error') {
      break;
    }
  }

  if (clipIds.length === 0) {
    throw new Error('Producer finished but produced no clips (check the prompt, credits, or the song id).');
  }
  return { jobId, conversationId, title, clipIds, estimatedTime };
}

// Back-compat alias.
export const startGeneration = sendProducerMessage;

const CLIP_READY = (clip) =>
  clip &&
  clip.duration &&
  clip.duration.status === 'completed' &&
  (clip.wav_url || clip.audio_url);

/**
 * Poll /clips until every clip has finished rendering (audio urls available).
 * @returns {Promise<Object[]>} array of full clip objects, in the requested order.
 */
export async function waitForClips(clipIds, { client = new FlowClient(), timeoutMs = config.clipTimeoutMs, intervalMs = 3000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const clips = await client.getClips(clipIds);
    const list = clipIds.map((id) => clips[id]).filter(Boolean);
    const ready = list.filter(CLIP_READY);
    if (onProgress) onProgress({ ready: ready.length, total: clipIds.length });
    if (ready.length === clipIds.length && ready.length > 0) return clipIds.map((id) => clips[id]).filter(CLIP_READY);
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for clips to render (${ready.length}/${clipIds.length} ready after ${Math.round(timeoutMs / 1000)}s).`
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Generate a song from a prompt and wait until its clip(s) are rendered.
 * Returns every variation the Producer decided to make (no forcing).
 *
 * @returns {Promise<{jobId,conversationId,title,clipIds,clips}>}
 */
export async function generateSong(prompt, opts = {}) {
  const client = opts.client || new FlowClient();
  const gen = await sendProducerMessage(prompt, { ...opts, client });
  const clips = await waitForClips(gen.clipIds, { ...opts, client });
  return { ...gen, title: gen.title || clips[0]?.title || null, clips };
}

/**
 * Edit an existing song by continuing its conversation. Covers remix, cover,
 * extend, variation and any free-form tweak — the Producer interprets `prompt`.
 *
 * @param {object} p
 * @param {string} p.conversationId   conversation to continue (from a prior generateSong)
 * @param {string} p.currentSongId    clip to act on
 * @param {string} p.prompt           the edit instruction
 * @returns {Promise<{jobId,conversationId,title,clipIds,clips}>}
 */
export async function editSong({ conversationId, currentSongId, prompt }, opts = {}) {
  if (!conversationId) throw new Error('editSong requires a conversationId');
  if (!prompt) throw new Error('editSong requires a prompt');
  const client = opts.client || new FlowClient();
  const gen = await sendProducerMessage(prompt, {
    ...opts,
    client,
    conversationId,
    currentSongId,
  });
  const clips = await waitForClips(gen.clipIds, { ...opts, client });
  return { ...gen, title: gen.title || clips[0]?.title || null, clips };
}

// Preset phrasings for the common edit operations. `prompt` may override/extend.
export const EDIT_PRESETS = {
  variation: (extra) => `Make a new variation of this track${extra ? `: ${extra}` : ''}.`,
  extend: (extra) => `Extend this track, keeping the same style and vibe${extra ? `. ${extra}` : ''}.`,
  remix: (extra) => `Remix this track${extra ? ` as ${extra}` : ' into a fresh new style'}.`,
  cover: (extra) => `Make a cover of this track${extra ? ` in a ${extra} style` : ' in a different genre'}.`,
};

/**
 * Convenience wrapper for a named edit operation.
 * @param {'variation'|'extend'|'remix'|'cover'} op
 */
export async function editOperation(op, { conversationId, currentSongId, prompt } = {}, opts = {}) {
  const preset = EDIT_PRESETS[op];
  if (!preset) throw new Error(`Unknown edit operation: ${op} (use variation|extend|remix|cover)`);
  const finalPrompt = preset(prompt);
  return editSong({ conversationId, currentSongId, prompt: finalPrompt }, opts);
}
