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
  async sendMessage(prompt, { conversationId, modelName, mode, clientContext = {} } = {}) {
    const body = {
      parts: [{ content: prompt, part_kind: 'user-prompt' }],
      client_context: clientContext,
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
}
