// One-shot local receiver that writes a posted session to secrets/session.json.
// Used together with scripts/extract-session.js (see that file's instructions).
// Runs on 127.0.0.1:8799 and accepts a single JSON POST from the browser tab.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'secrets', 'session.json');
const PORT = 8799;

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(200); return res.end('receiver up — POST your session here'); }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (!json.refresh_token || !json.access_token) throw new Error('missing tokens');
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(json, null, 2));
        console.log(`✅  session saved to ${OUT} (hasRefresh=${!!json.refresh_token})`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        console.error('❌  save failed:', e.message);
        res.writeHead(400); res.end('{"ok":false}');
      }
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`🎯  session-receiver listening on http://127.0.0.1:${PORT} — now paste the console snippet`));
