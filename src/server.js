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
//     /generate and /edit return JSON with the resulting clip(s). Each clip has a
//     `download_url` (in the requested `format`, default wav) plus links for every
//     format. Download each variation as its own separate file from its url.
//   GET  /clips/:id                   clip metadata + download links (JSON)
//   GET  /clips/:id/audio?format=     download one clip's audio (mp3|wav|m4a)
//                                      &redirect=1 -> 302 to public CDN (wav/m4a, saves bandwidth)
//                                      &inline=1   -> inline instead of attachment
//   POST /upload/image  (multipart)   field "image"  -> upload reference for `uploads`
//   POST /upload/audio  (multipart)   field "audio"  -> upload reference for `uploads`
//
// A generation returns whatever variations the Producer decides to make.

import express from 'express';
import multer from 'multer';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { defaultSession } from './auth/session.js';
import { FlowClient } from './client/flowClient.js';
import { generateSong, editSong, editOperation, EDIT_PRESETS } from './services/generate.js';
import { clipAudioUrl, publicClipUrl, SUPPORTED_FORMATS } from './services/download.js';

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

function clipView(req, clip, format = config.defaultFormat) {
  const base = baseUrl(req);
  const link = (fmt) => `${base}/clips/${clip.id}/audio?format=${fmt}`;
  return {
    id: clip.id,
    title: clip.title || null,
    op_type: clip.op_type || clip.operation?.op_type || null,
    duration_seconds: clip.duration?.value ? Math.round(Number(clip.duration.value)) : null,
    image_url: clip.image_url || null,
    // Download this clip in the requested format (one file, one URL):
    download_url: link(format),
    // Same clip in every format, if you want a different one:
    download: { mp3: link('mp3'), m4a: link('m4a'), wav: link('wav') },
    // Direct public CDN files (no auth) for wav/m4a:
    wav_url: clip.wav_url || publicClipUrl(clip.id, 'wav'),
    m4a_url: clip.audio_url || publicClipUrl(clip.id, 'm4a'),
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
    // Return one download link per clip. Each variation is its own separate
    // file, fetched independently from its download_url.
    res.json({
      title: result.title,
      conversation_id: result.conversationId,
      count: result.clips.length,
      clips: result.clips.map((c) => clipView(req, c, format)),
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
    res.json({
      title: result.title,
      conversation_id: result.conversationId,
      count: result.clips.length,
      clips: result.clips.map((c) => clipView(req, c, format)),
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
  const safe = (s) => (s || req.params.id).replace(/[^\w\-]+/g, '_').slice(0, 80);
  const ctype = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }[format];
  try {
    if (format === 'mp3') {
      // mp3 is transcoded on demand. Its HTTP/2 stream can abort mid-pipe, so we
      // buffer the (small, ~2-3 MB) file fully and send it in one shot.
      const clip = await client.getClip(req.params.id).catch(() => null);
      const up = await client.downloadAudio(req.params.id, 'mp3');
      const buf = Buffer.from(await up.arrayBuffer());
      res.setHeader('content-type', ctype);
      res.setHeader('content-disposition', `${disposition}; filename="${safe(clip?.title)}.mp3"`);
      return res.send(buf);
    }

    // wav / m4a live on the public CDN.
    const clip = await client.getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    if (req.query.redirect) return res.redirect(302, clipAudioUrl(clip, format));

    const up = await fetch(clipAudioUrl(clip, format));
    if (!up.ok) return res.status(502).json({ error: `Upstream ${up.status} fetching audio` });
    res.setHeader('content-type', ctype);
    res.setHeader('content-disposition', `${disposition}; filename="${safe(clip.title)}.${format}"`);

    // Stream with explicit error handling so an upstream/client abort can never
    // crash the process (an unhandled stream 'error' would take the server down).
    const nodeStream = Readable.fromWeb(up.body);
    nodeStream.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: err.message });
      else res.destroy(err);
    });
    res.on('close', () => nodeStream.destroy());
    nodeStream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
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

// Safety net: a stray stream/socket error must not take the whole API down.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err?.message || err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.message || err));

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
