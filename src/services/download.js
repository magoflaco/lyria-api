// Download rendered clips. Audio lives on public Google Cloud Storage, so no
// auth is needed for the actual file fetch:
//   https://storage.googleapis.com/producer-app-public/clips/{clip_id}.{wav|m4a}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';

function sanitize(name) {
  return (name || 'clip')
    .replace(/[^\w\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'clip';
}

export function clipAudioUrl(clip, format = config.defaultFormat) {
  if (format === 'wav') return clip.wav_url || `${config.publicStorageBase}/${clip.id}.wav`;
  if (format === 'm4a') return clip.audio_url || `${config.publicStorageBase}/${clip.id}.m4a`;
  throw new Error(`Unsupported format: ${format} (use wav or m4a)`);
}

/**
 * Download a single clip to disk.
 * @returns {Promise<{clipId,title,format,path,bytes,url}>}
 */
export async function downloadClip(clip, { format = config.defaultFormat, dir = config.downloadDir, filename } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const url = clipAudioUrl(clip, format);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download clip ${clip.id} (${res.status}) from ${url}`);
  }

  const base = filename || `${sanitize(clip.title)}-${clip.id.slice(0, 8)}.${format}`;
  const outPath = path.join(dir, base);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outPath));
  const bytes = (await fsp.stat(outPath)).size;
  return { clipId: clip.id, title: clip.title || null, format, path: outPath, bytes, url };
}

/** Download every clip (e.g. both variations) of a generation. */
export async function downloadClips(clips, opts = {}) {
  const results = [];
  for (const clip of clips) {
    results.push(await downloadClip(clip, opts));
  }
  return results;
}
