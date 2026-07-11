// HTTP API wrapper for Google Flow Music (Lyria).
//
// Endpoints (all JSON unless noted):
//   GET  /health                         -> { ok, session: { expired, expiresAt } }
//   POST /generate                       -> generate a song (blocks until rendered)
//        body: { prompt, variations=2, format="wav", download=false }
//   GET  /clips/:id                      -> clip metadata (incl. wav_url / audio_url)
//   GET  /clips/:id/audio?format=wav     -> 302 redirect to the public audio file
//   POST /download                       -> server-side download of clips to disk
//        body: { clip_ids: [...], format="wav" }
//
// Optional: set API_KEY to require `Authorization: Bearer <API_KEY>` on all
// endpoints except /health.

import express from 'express';
import { config } from './config.js';
import { defaultSession } from './auth/session.js';
import { FlowClient } from './client/flowClient.js';
import { generateSong } from './services/generate.js';
import { downloadClips, clipAudioUrl } from './services/download.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- auth guard for this wrapper's own endpoints ---------------------------
app.use((req, res, next) => {
  if (!config.apiKey || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== config.apiKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const client = new FlowClient();

function clipView(clip) {
  return {
    id: clip.id,
    title: clip.title || null,
    duration_seconds: clip.duration?.value ? Math.round(Number(clip.duration.value)) : null,
    has_vocals: clip.has_vocals ?? null,
    wav_url: clip.wav_url || clipAudioUrl(clip, 'wav'),
    audio_url: clip.audio_url || clipAudioUrl(clip, 'm4a'),
    image_url: clip.image_url || null,
  };
}

app.get('/health', async (req, res) => {
  let session = null;
  try {
    defaultSession.load();
    session = { expired: defaultSession.isExpired(), expiresAt: defaultSession.session.expires_at };
  } catch (e) {
    session = { error: e.message };
  }
  res.json({ ok: true, service: 'lyria-api', session });
});

app.post('/generate', async (req, res) => {
  const { prompt, variations, format = config.defaultFormat, download = false } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Body must include a non-empty "prompt" string.' });
  }
  try {
    const result = await generateSong(prompt, { client, variations });
    const payload = {
      title: result.title,
      conversation_id: result.conversationId,
      clips: result.clips.map(clipView),
    };
    if (download) {
      const files = await downloadClips(result.clips, { format });
      payload.files = files.map((f) => ({ clip_id: f.clipId, path: f.path, bytes: f.bytes, format: f.format }));
    }
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
  try {
    const format = (req.query.format || config.defaultFormat).toString().toLowerCase();
    const clip = await client.getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    res.redirect(302, clipAudioUrl(clip, format));
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
    const files = await downloadClips(list, { format });
    res.json({ files: files.map((f) => ({ clip_id: f.clipId, path: f.path, bytes: f.bytes, format: f.format })) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(config.port, () => {
  console.log(`🎧  lyria-api listening on http://localhost:${config.port}`);
  if (config.apiKey) console.log('🔒  API key protection enabled');
});

export { app, server };
