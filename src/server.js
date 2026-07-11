// HTTP API wrapper for Google Flow Music (Lyria).
//
// Endpoints (JSON unless noted). All except /health require
// `Authorization: Bearer <API_KEY>` when API_KEY is set.
//
//   GET  /health                      service + session status
//   POST /generate                    { prompt, format?, download? }
//   POST /edit                        { conversation_id, current_song_id?, prompt?, operation?, format?, download? }
//                                      operation ∈ variation | extend | remix | cover (or free-form prompt)
//   GET  /clips/:id                   clip metadata
//   GET  /clips/:id/audio?format=     stream/redirect the audio (mp3|wav|m4a)
//   POST /download                    { clip_ids:[...], format? }
//   POST /upload/image  (multipart)   field "image"  -> { image_url, image_id }
//   POST /upload/audio  (multipart)   field "audio"  -> upload descriptor
//
// A generation returns whatever variations the Producer decides to make.

import express from 'express';
import multer from 'multer';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { defaultSession } from './auth/session.js';
import { FlowClient } from './client/flowClient.js';
import { generateSong, editSong, editOperation, EDIT_PRESETS } from './services/generate.js';
import { downloadClips, clipAudioUrl, publicClipUrl, SUPPORTED_FORMATS } from './services/download.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const client = new FlowClient();

// --- auth guard for this wrapper's own endpoints ---------------------------
app.use((req, res, next) => {
  if (!config.apiKey || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== config.apiKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

function clipView(clip) {
  return {
    id: clip.id,
    title: clip.title || null,
    op_type: clip.op_type || clip.operation?.op_type || null,
    duration_seconds: clip.duration?.value ? Math.round(Number(clip.duration.value)) : null,
    wav_url: clip.wav_url || publicClipUrl(clip.id, 'wav'),
    m4a_url: clip.audio_url || publicClipUrl(clip.id, 'm4a'),
    image_url: clip.image_url || null,
  };
}

const asFiles = (files) =>
  files.map((f) => ({ clip_id: f.clipId, path: f.path, bytes: f.bytes, format: f.format }));

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
  const { prompt, format = config.defaultFormat, download = false, uploads } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Body must include a non-empty "prompt" string.' });
  }
  try {
    const result = await generateSong(prompt, { client, uploads });
    const payload = {
      title: result.title,
      conversation_id: result.conversationId,
      clips: result.clips.map(clipView),
    };
    if (download) payload.files = asFiles(await downloadClips(result.clips, { format, client }));
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/edit', async (req, res) => {
  const { conversation_id, current_song_id, prompt, operation, format = config.defaultFormat, download = false } =
    req.body || {};
  if (!conversation_id) return res.status(400).json({ error: 'Body must include "conversation_id".' });
  if (!operation && !prompt) {
    return res.status(400).json({ error: 'Provide "operation" (variation|extend|remix|cover) and/or a "prompt".' });
  }
  if (operation && !EDIT_PRESETS[operation]) {
    return res.status(400).json({ error: `Unknown operation "${operation}" (use ${Object.keys(EDIT_PRESETS).join('|')}).` });
  }
  try {
    const args = { conversationId: conversation_id, currentSongId: current_song_id, prompt };
    const result = operation
      ? await editOperation(operation, args, { client })
      : await editSong(args, { client });
    const payload = {
      title: result.title,
      conversation_id: result.conversationId,
      clips: result.clips.map(clipView),
    };
    if (download) payload.files = asFiles(await downloadClips(result.clips, { format, client }));
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/clips/:id', async (req, res) => {
  try {
    const clip = await client.getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    res.json(clipView(clip));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/clips/:id/audio', async (req, res) => {
  const format = (req.query.format || config.defaultFormat).toString().toLowerCase();
  if (!SUPPORTED_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Unsupported format (use ${SUPPORTED_FORMATS.join(', ')}).` });
  }
  try {
    // wav/m4a live on public GCS -> redirect. mp3 must be transcoded -> proxy.
    if (format === 'wav' || format === 'm4a') {
      const clip = await client.getClip(req.params.id);
      if (!clip) return res.status(404).json({ error: 'Clip not found' });
      return res.redirect(302, clipAudioUrl(clip, format));
    }
    const upstream = await client.downloadAudio(req.params.id, format);
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('content-disposition', `inline; filename="${req.params.id}.mp3"`);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/download', async (req, res) => {
  const { clip_ids, format = config.defaultFormat } = req.body || {};
  if (!Array.isArray(clip_ids) || clip_ids.length === 0) {
    return res.status(400).json({ error: 'Body must include a non-empty "clip_ids" array.' });
  }
  try {
    const clips = await client.getClips(clip_ids);
    const list = clip_ids.map((id) => clips[id]).filter(Boolean);
    if (list.length === 0) return res.status(404).json({ error: 'No matching clips found' });
    res.json({ files: asFiles(await downloadClips(list, { format, client })) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Upload an image (inspiration for lyrics/cover) -> returns a reference you can
// pass in the `uploads` array of POST /generate.
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

// Upload an audio file to build from (max ~4 min) -> returns a reference you can
// pass in the `uploads` array of POST /generate.
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
