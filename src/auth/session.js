// Session manager: holds the Flow Music (Supabase) session and keeps the
// access token fresh so the wrapper can run unattended (e.g. on a VPS).
//
// The session file is created once during login extraction and contains:
//   { access_token, refresh_token, expires_at, anon_key, supabase_url, ... }
// When the access token nears expiry it is transparently refreshed against
// GoTrue at `${supabase_url}/auth/v1/token?grant_type=refresh_token`.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const REFRESH_SKEW_SECONDS = 120; // refresh a bit before actual expiry

export class SessionManager {
  constructor(sessionFile = config.sessionFile) {
    this.sessionFile = sessionFile;
    this.session = null;
    this._refreshing = null; // in-flight refresh promise (dedupe concurrent calls)
  }

  load() {
    if (!fs.existsSync(this.sessionFile)) {
      throw new Error(
        `No session file at ${this.sessionFile}. Run the login extraction first (see README).`
      );
    }
    this.session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    if (!this.session.refresh_token) {
      throw new Error('Session file is missing refresh_token — re-extract the session.');
    }
    return this.session;
  }

  ensureLoaded() {
    if (!this.session) this.load();
    return this.session;
  }

  async persist() {
    await fsp.mkdir(path.dirname(this.sessionFile), { recursive: true });
    await fsp.writeFile(this.sessionFile, JSON.stringify(this.session, null, 2));
  }

  isExpired() {
    const s = this.ensureLoaded();
    if (!s.expires_at) return true;
    const now = Math.floor(Date.now() / 1000);
    return now >= s.expires_at - REFRESH_SKEW_SECONDS;
  }

  /** Returns a currently-valid access token, refreshing if necessary. */
  async getAccessToken() {
    const s = this.ensureLoaded();
    if (this.isExpired()) await this.refresh();
    return this.session.access_token;
  }

  async refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  async _doRefresh() {
    const s = this.ensureLoaded();
    const url = `${s.supabase_url || config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: s.anon_key,
        authorization: `Bearer ${s.anon_key}`,
      },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    this.session = {
      ...s,
      access_token: data.access_token,
      refresh_token: data.refresh_token || s.refresh_token,
      expires_in: data.expires_in,
      expires_at:
        data.expires_at ||
        Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      token_type: data.token_type || s.token_type || 'bearer',
    };
    await this.persist();
    return this.session;
  }
}

export const defaultSession = new SessionManager();
