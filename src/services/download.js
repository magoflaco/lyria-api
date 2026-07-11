// Download rendered clips in mp3 / m4a / wav.
//
//  - wav & m4a exist as public files on Google Cloud Storage (no auth, fast):
//      https://storage.googleapis.com/producer-app-public/clips/{id}.{wav|m4a}
//  - mp3 is transcoded on demand by Flow Music and must be fetched through the
//    authenticated endpoint GET /__api/download/audio/{id}?format=mp3
//
// Any format can also be forced through the authenticated endpoint via
// `{ viaApi: true }` (useful if a GCS object is missing).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { FlowClient } from '../client/flowClient.js';

export const SUPPORTED_FORMATS = ['mp3', 'm4a', 'wav'];

function sanitize(name) {
  return (
    (name || 'clip')
      .replace(/[^\w\-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'clip'
  );
}

/** Public GCS url for wav/m4a (mp3 is not published there). */
export function publicClipUrl(clipId, format) {
  if (format === 'wav' || format === 'm4a') return `${config.publicStorageBase}/${clipId}.${format}`;
  return null;
}

export function clipAudioUrl(clip, format = config.defaultFormat) {
  if (format === 'wav') return clip.wav_url || publicClipUrl(clip.id, 'wav');
  if (format === 'm4a') return clip.audio_url || publicClipUrl(clip.id, 'm4a');
  if (format === 'mp3') return null; // mp3 only via authenticated endpoint
  throw new Error(`Unsupported format: ${format} (use ${SUPPORTED_FORMATS.join(', ')})`);
}

/**
 * Download a single clip to disk.
 * @param {object} clip   clip metadata (must include id; title used for filename)
 * @returns {Promise<{clipId,title,format,path,bytes,url}>}
 */
export async function downloadClip(
  clip,
  { format = config.defaultFormat, dir = config.downloadDir, filename, viaApi = false, client } = {}
) {
  format = format.toLowerCase();
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`Unsupported format: ${format} (use ${SUPPORTED_FORMATS.join(', ')})`);
  }
  await fsp.mkdir(dir, { recursive: true });

  const publicUrl = viaApi ? null : clipAudioUrl(clip, format);
  let body;
  let sourceUrl;

  if (publicUrl) {
    const res = await fetch(publicUrl);
    if (!res.ok) throw new Error(`Failed to download clip ${clip.id} (${res.status}) from ${publicUrl}`);
    body = res.body;
    sourceUrl = publicUrl;
  } else {
    // mp3, or forced-via-api: use the authenticated transcoding endpoint
    const fc = client || new FlowClient();
    const res = await fc.downloadAudio(clip.id, format);
    body = res.body;
    sourceUrl = `${config.apiBase}/download/audio/${clip.id}?format=${format}`;
  }

  const base = filename || `${sanitize(clip.title)}-${clip.id.slice(0, 8)}.${format}`;
  const outPath = path.join(dir, base);
  await pipeline(Readable.fromWeb(body), fs.createWriteStream(outPath));
  const bytes = (await fsp.stat(outPath)).size;
  return { clipId: clip.id, title: clip.title || null, format, path: outPath, bytes, url: sourceUrl };
}

/** Download every clip (e.g. both variations) of a generation. */
export async function downloadClips(clips, opts = {}) {
  const results = [];
  for (const clip of clips) results.push(await downloadClip(clip, opts));
  return results;
}
