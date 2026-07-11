// Low-level client for the Flow Music internal API (`/__api`).
// All endpoints authenticate with the Supabase access token as a Bearer.
// Endpoint contract was reverse-engineered from the web app:
//
//   POST /conversation/create            { project_id? }              -> { conversation_id }
//   POST /conversation                   { parts, client_context,     -> { job_id }
//                                          conversation_id?, model_name?, mode? }
//   GET  /messages/{job_id}/stream?last_id=0                          -> text/event-stream
//   POST /clips                          { clip_ids: [...] }          -> { clips: { id: {...} } }
//
// The stream emits `audio__create_song` tool-return parts carrying the clip ids.

import { config } from '../config.js';
import { defaultSession } from '../auth/session.js';
import { parseSSE } from './sse.js';

export class FlowClient {
  constructor(session = defaultSession, opts = {}) {
    this.session = session;
    this.apiBase = opts.apiBase || config.apiBase;
    this.userAgent = opts.userAgent || config.userAgent;
  }

  async _headers(extra = {}) {
    const token = await this.session.getAccessToken();
    return {
      authorization: `Bearer ${token}`,
      'user-agent': this.userAgent,
      origin: 'https://www.flowmusic.app',
      referer: 'https://www.flowmusic.app/',
      ...extra,
    };
  }

  async _request(method, path, { body, retryOn401 = true } = {}) {
    const headers = await this._headers(
      body !== undefined ? { 'content-type': 'application/json' } : {}
    );
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Access token might have gone stale mid-flight: refresh once and retry.
    if (res.status === 401 && retryOn401) {
      await this.session.refresh();
      return this._request(method, path, { body, retryOn401: false });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Flow API ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res;
  }

  async _json(method, path, opts) {
    const res = await this._request(method, path, opts);
    return res.json();
  }

  /** Create an empty conversation and return its id. */
  async createConversation(projectId = null) {
    const data = await this._json('POST', '/conversation/create', {
      body: { project_id: projectId },
    });
    return data.conversation_id;
  }

  /**
   * Send a prompt to the Producer. Returns a job_id whose stream produces the
   * generated clips. `conversation_id` is optional; when omitted the backend
   * starts a fresh conversation.
   */
  async sendMessage(prompt, { conversationId, currentSongId, modelName, mode, clientContext = {}, parts, uploads } = {}) {
    const context = { ...clientContext };
    if (currentSongId) context.current_song_id = currentSongId;

    // Multimodal: attach uploaded audio/image references as extra content items
    // in the user-prompt part. Each upload: { kind:"image-url"|"audio-url", url,
    // media_type, name, duration_s? }.
    let defaultParts;
    if (uploads && uploads.length) {
      const content = [prompt, ...uploads.map((u) => ({
        kind: u.kind,
        url: u.url,
        media_type: u.media_type,
        name: u.name,
        ...(u.duration_s != null ? { duration_s: u.duration_s } : {}),
      }))];
      defaultParts = [{ content, part_kind: 'user-prompt' }];
    } else {
      defaultParts = [{ content: prompt, part_kind: 'user-prompt' }];
    }

    const body = {
      parts: parts || defaultParts,
      client_context: context,
    };
    if (conversationId) body.conversation_id = conversationId;
    if (modelName) body.model_name = modelName;
    if (mode) body.mode = mode;
    const data = await this._json('POST', '/conversation', { body });
    return data.job_id;
  }

  /** Open the SSE stream for a job. Returns an async iterator of parsed events. */
  async openJobStream(jobId, lastId = 0) {
    const res = await this._request(
      'GET',
      `/messages/${encodeURIComponent(jobId)}/stream?last_id=${lastId}`
    );
    return parseSSE(res);
  }

  /** Fetch full metadata (incl. audio_url / wav_url) for one or more clips. */
  async getClips(clipIds) {
    const ids = Array.isArray(clipIds) ? clipIds : [clipIds];
    const data = await this._json('POST', '/clips', { body: { clip_ids: ids } });
    return data.clips || {};
  }

  async getClip(clipId) {
    const clips = await this.getClips([clipId]);
    return clips[clipId] || null;
  }

  /**
   * Server-side transcoded audio download. Works for mp3/wav/m4a and returns a
   * fetch Response streaming the audio bytes. Needed for mp3 (not on GCS).
   */
  async downloadAudio(clipId, format = 'mp3') {
    return this._request('GET', `/download/audio/${encodeURIComponent(clipId)}?format=${encodeURIComponent(format)}`);
  }

  // --- uploads (multipart) --------------------------------------------------

  async _multipart(path, form) {
    const token = await this.session.getAccessToken();
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': this.userAgent,
        origin: 'https://www.flowmusic.app',
        referer: 'https://www.flowmusic.app/',
      }, // NB: let fetch set the multipart content-type + boundary
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Flow API POST ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Upload an image (or any file) to use as inspiration in a generation.
   * `file_type` is the file's MIME type. Returns { id, url }.
   */
  async uploadImage(data, { filename = 'image.png', type = 'image/png' } = {}) {
    const form = new FormData();
    form.append('file', new Blob([data], { type }), filename);
    form.append('file_type', type);
    return this._multipart('/producer/upload', form);
  }

  /**
   * Upload an audio file to build from (must be under 4 minutes).
   * Returns the upload descriptor (id + url) the Producer can reference.
   */
  async uploadAudio(data, { filename = 'audio.mp3', type = 'audio/mpeg', checkVocals = false } = {}) {
    const form = new FormData();
    form.append('file', new Blob([data], { type }), filename);
    form.append('file_type', type);
    form.append('filename', filename);
    form.append('check_vocals', String(checkVocals));
    return this._multipart('/producer/upload-audio', form);
  }
}
