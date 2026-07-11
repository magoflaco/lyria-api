// Central configuration. Reads environment variables with sane defaults.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load a local .env if present (Node >=20.12). No external dependency.
try {
  const envPath = path.resolve(root, '.env');
  if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
} catch {
  /* ignore — env vars can still be provided by the process manager */
}

const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

export const config = {
  root,
  port: Number(process.env.PORT || 8787),
  apiKey: process.env.API_KEY || '', // protects this wrapper's own HTTP endpoints when set
  sessionFile: resolve(process.env.SESSION_FILE || './secrets/session.json'),
  downloadDir: resolve(process.env.DOWNLOAD_DIR || './downloads'),
  defaultFormat: (process.env.DEFAULT_FORMAT || 'wav').toLowerCase(),
  clipTimeoutMs: Number(process.env.CLIP_TIMEOUT_SECONDS || 240) * 1000,

  // Flow Music internal endpoints (discovered by inspecting the web app)
  apiBase: 'https://www.flowmusic.app/__api',
  supabaseUrl: 'https://sb.flowmusic.app',
  publicStorageBase: 'https://storage.googleapis.com/producer-app-public/clips',

  // A browser-like UA avoids naive bot filtering on the edge
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};
