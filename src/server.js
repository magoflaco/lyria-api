// HTTP API wrapper for Google Flow Music (Lyria).
//
// This is a hosted API: it returns clip metadata plus ready-to-use audio links,
// and streams the audio bytes straight to the CALLER. It does not persist audio
// on the server's disk.
//
// Endpoints (JSON unless noted). All except /health require
// `Authorization: Bearer <API_KEY>` when API_KEY is set.
//
//   GET  /health                      service + session status
//   POST /generate                    { prompt, format?, uploads? }
//   POST /edit                        { conversation_id, current_song_id?, prompt?, operation?, format? }
//                                      operation ∈ variation | extend | remix | cover (or free-form prompt)
//     /generate and /edit ALWAYS return the audio to the caller:
//       - format defaults to DEFAULT_FORMAT (wav); pass mp3 | m4a | wav to choose
//       - 1 clip  -> the audio file
//       - N clips -> multipart/mixed, one audio file per variation
//     conversation id / clip ids / title come back in X-Conversation-Id,
//     X-Clip-Ids and X-Title headers so you can keep editing.
//   GET  /clips/:id                   clip metadata + download links (JSON)
//   GET  /clips/:id/audio?format=     stream one clip's audio to the caller (mp3|wav|m4a)
//                                      &redirect=1 -> 302 to public CDN (wav/m4a, saves bandwidth)
//                                      &inline=1   -> inline instead of attachment
//   POST /upload/image  (multipart)   field "image"  -> upload reference for `uploads`
//   POST /upload/audio  (multipart)   field "audio"  -> upload reference for `uploads`
//
// A generation returns whatever variations the Producer decides to make.

import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { defaultSession } from './auth/session.js';
import { FlowClient } from './client/flowClient.js';
import { generateSong, editSong, editOperation, EDIT_PRESETS } from './services/generate.js';
import { clipAudioUrl, publicClipUrl, SUPPORTED_FORMATS } from './services/download.js';

const CTYPE = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
const safeName = (s) => (s || 'clip').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'clip';

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 45 * 1024 * 1024 } });
const client = new FlowClient();

// --- auth guard for this wrapper's own endpoints ---------------------------
app.use((req, res, next) => {
  if (!config.apiKey || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== config.apiKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Absolute base url of THIS api, for building download links.
function baseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  return `${req.protocol}://${req.get('host')}`;
}

// Fetch a clip's audio bytes: wav/m4a from the public CDN, mp3 via transcode.
async function clipAudioStream(clip, format) {
  if (format === 'mp3') {
    const up = await client.downloadAudio(clip.id, 'mp3');
    return up.body;
  }
  const up = await fetch(clipAudioUrl(clip, format));
  if (!up.ok) throw new Error(`Upstream ${up.status} fetching ${format} for ${clip.id}`);
  return up.body;
}

// Write a readable stream's chunks into res WITHOUT ending the response.
function writeStreamToRes(readable, res) {
  return new Promise((resolve, reject) => {
    readable.on('data', (c) => res.write(c));
    readable.on('end', resolve);
    readable.on('error', reject);
  });
}

// Send the generated/edited clips straight to the caller as a download:
//   1 clip  -> the audio file itself
//   N clips -> a multipart/mixed response with one audio file per variation
// Clip ids / conversation id / title travel in headers so the caller can keep
// editing without a second request.
async function sendAudioDownload(res, { clips, format, title, conversationId }) {
  res.setHeader('X-Conversation-Id', conversationId || '');
  res.setHeader('X-Clip-Ids', clips.map((c) => c.id).join(','));
  res.setHeader('X-Title', encodeURIComponent(title || ''));
  res.setHeader('Access-Control-Expose-Headers', 'X-Conversation-Id, X-Clip-Ids, X-Title');

  // Single clip -> return the audio file directly.
  if (clips.length === 1) {
    const clip = clips[0];
    const body = await clipAudioStream(clip, format);
    res.setHeader('content-type', CTYPE[format]);
    res.setHeader('content-disposition', `attachment; filename="${safeName(clip.title)}.${format}"`);
    return Readable.fromWeb(body).pipe(res);
  }

  // Several variations -> multipart/mixed, one file part per clip.
  const boundary = `lyria-${crypto.randomBytes(8).toString('hex')}`;
  res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
  for (const clip of clips) {
    const body = await clipAudioStream(clip, format);
    const filename = `${safeName(clip.title)}-${clip.id.slice(0, 8)}.${format}`;
    res.write(`--${boundary}\r\n`);
    res.write(`Content-Type: ${CTYPE[format]}\r\n`);
    res.write(`Content-Disposition: attachment; filename="${filename}"\r\n\r\n`);
    await writeStreamToRes(Readable.fromWeb(body), res);
    res.write('\r\n');
  }
  res.end(`--${boundary}--\r\n`);
}

function clipView(req, clip) {
  const base = baseUrl(req);
  const link = (fmt) => `${base}/clips/${clip.id}/audio?format=${fmt}`;
  return {
    id: clip.id,
    title: clip.title || null,
    op_type: clip.op_type || clip.operation?.op_type || null,
    duration_seconds: clip.duration?.value ? Math.round(Number(clip.duration.value)) : null,
    image_url: clip.image_url || null,
    // Direct public CDN files (no auth) for wav/m4a:
    wav_url: clip.wav_url || publicClipUrl(clip.id, 'wav'),
    m4a_url: clip.audio_url || publicClipUrl(clip.id, 'm4a'),
    // Download links served BY THIS API (streamed to the caller; mp3 too):
    download: { mp3: link('mp3'), m4a: link('m4a'), wav: link('wav') },
  };
}

app.get('/health', (req, res) => {
  let session = null;
  try {
    defaultSession.load();
    session = { expired: defaultSession.isExpired(), expiresAt: defaultSession.session.expires_at };
  } catch (e) {
    session = { error: e.message };
  }
  res.json({ ok: true, service: 'lyria-api', formats: SUPPORTED_FORMATS, session });
});

app.post('/generate', async (req, res) => {
  const { prompt, uploads } = req.body || {};
  const format = (req.body?.format || req.query.format || config.defaultFormat).toString().toLowerCase();
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Body must include a non-empty "prompt" string.' });
  }
  if (!SUPPORTED_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Unsupported format (use ${SUPPORTED_FORMATS.join(', ')}).` });
  }
  try {
    const result = await generateSong(prompt, { client, uploads });
    // Always download the audio to the caller: one file, or several (multipart)
    // when the Producer makes multiple variations.
    await sendAudioDownload(res, {
      clips: result.clips,
      format,
      title: result.title,
      conversationId: result.conversationId,
    });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

app.post('/edit', async (req, res) => {
  const { conversation_id, current_song_id, prompt, operation } = req.body || {};
  const format = (req.body?.format || req.query.format || config.defaultFormat).toString().toLowerCase();
  if (!conversation_id) return res.status(400).json({ error: 'Body must include "conversation_id".' });
  if (!operation && !prompt) {
    return res.status(400).json({ error: 'Provide "operation" (variation|extend|remix|cover) and/or a "prompt".' });
  }
  if (operation && !EDIT_PRESETS[operation]) {
    return res.status(400).json({ error: `Unknown operation "${operation}" (use ${Object.keys(EDIT_PRESETS).join('|')}).` });
  }
  if (!SUPPORTED_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Unsupported format (use ${SUPPORTED_FORMATS.join(', ')}).` });
  }
  try {
    const args = { conversationId: conversation_id, currentSongId: current_song_id, prompt };
    const result = operation
      ? await editOperation(operation, args, { client })
      : await editSong(args, { client });
    await sendAudioDownload(res, {
      clips: result.clips,
      format,
      title: result.title,
      conversationId: result.conversationId,
    });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

app.get('/clips/:id', async (req, res) => {
  try {
    const clip = await client.getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    res.json(clipView(req, clip));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Stream the audio to the caller (the end user downloads it from here).
app.get('/clips/:id/audio', async (req, res) => {
  const format = (req.query.format || config.defaultFormat).toString().toLowerCase();
  if (!SUPPORTED_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Unsupported format (use ${SUPPORTED_FORMATS.join(', ')}).` });
  }
  const disposition = req.query.inline ? 'inline' : 'attachment';
  try {
    // For wav/m4a, optionally 302 to the public CDN to save the server's bandwidth.
    if (req.query.redirect && (format === 'wav' || format === 'm4a')) {
      return res.redirect(302, publicClipUrl(req.params.id, format));
    }

    // Otherwise stream the bytes through the API with a friendly filename.
    let filename = `${req.params.id}.${format}`;
    let upstreamBody;
    const ctype = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }[format];

    if (format === 'mp3') {
      const up = await client.downloadAudio(req.params.id, 'mp3');
      upstreamBody = up.body;
      const clip = await client.getClip(req.params.id).catch(() => null);
      if (clip?.title) filename = `${clip.title.replace(/[^\w\-]+/g, '_')}.mp3`;
    } else {
      const clip = await client.getClip(req.params.id);
      if (!clip) return res.status(404).json({ error: 'Clip not found' });
      const url = clipAudioUrl(clip, format);
      const up = await fetch(url);
      if (!up.ok) return res.status(502).json({ error: `Upstream ${up.status} fetching audio` });
      upstreamBody = up.body;
      if (clip.title) filename = `${clip.title.replace(/[^\w\-]+/g, '_')}.${format}`;
    }

    res.setHeader('content-type', ctype);
    res.setHeader('content-disposition', `${disposition}; filename="${filename}"`);
    Readable.fromWeb(upstreamBody).pipe(res);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Upload an image (inspiration) -> reference for the `uploads` array of /generate.
app.post('/upload/image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an image as multipart field "image".' });
  try {
    const type = req.file.mimetype || 'image/png';
    const name = req.file.originalname || 'image.png';
    const out = await client.uploadImage(req.file.buffer, { filename: name, type });
    res.json({ ...out, kind: 'image-url', media_type: type, name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Upload a source audio (build from) -> reference for the `uploads` array of /generate.
app.post('/upload/audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an audio file as multipart field "audio".' });
  try {
    const type = req.file.mimetype || 'audio/mpeg';
    const name = req.file.originalname || 'audio.mp3';
    const out = await client.uploadAudio(req.file.buffer, { filename: name, type });
    res.json({ ...out, kind: 'audio-url', media_type: type, name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(config.port, () => {
  console.log(`🎧  lyria-api listening on http://localhost:${config.port}`);
  if (config.apiKey) console.log('🔒  API key protection enabled');
  try {
    defaultSession.startKeepAlive();
    console.log('🔁  session keep-alive started');
  } catch (e) {
    console.error('⚠️  could not start session keep-alive:', e.message);
  }
});

export { app, server };
