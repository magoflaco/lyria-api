// ─────────────────────────────────────────────────────────────────────────
//  Flow Music session extractor  (run in the BROWSER, not with Node)
// ─────────────────────────────────────────────────────────────────────────
//
//  The wrapper authenticates as you using your Flow Music (Supabase) session.
//  Google's OAuth login only works in a normal browser, so the session is
//  captured once from a logged-in tab and written to secrets/session.json.
//
//  HOW TO USE
//  1. Log in at https://www.flowmusic.app in Chrome.
//  2. From the repo root run the tiny receiver:
//         node scripts/session-receiver.js
//  3. Open DevTools (F12) on the flowmusic.app tab -> Console, paste the
//     IIFE below, press Enter. It decodes your session cookie and POSTs it to
//     the local receiver, which writes secrets/session.json. Nothing is ever
//     printed to the page.
//  4. Ctrl+C the receiver. Done — the wrapper can now run headless anywhere.
//
//  When the refresh token eventually expires (long-lived, but not forever),
//  repeat these steps to refresh secrets/session.json.
//
//  ── paste everything below into the browser console ──
/*
(async () => {
  const raw = document.cookie.split(';').map(c => c.trim());
  const parts = {};
  for (const c of raw) {
    const eq = c.indexOf('='); const k = c.slice(0, eq), v = c.slice(eq + 1);
    const m = k.match(/^sb-sb-auth-token\.(\d+)$/);
    if (m) parts[+m[1]] = decodeURIComponent(v);
  }
  let combined = Object.keys(parts).map(Number).sort((a, b) => a - b).map(i => parts[i]).join('');
  if (combined.startsWith('base64-')) combined = combined.slice(7);
  const session = JSON.parse(atob(combined));

  // public anon key (shipped in the client bundle)
  let anon = null;
  for (const s of [...document.querySelectorAll('script[src]')].map(x => x.src).filter(x => x.includes('/_next/'))) {
    let txt = ''; try { txt = await (await fetch(s)).text(); } catch { continue; }
    const m = txt.match(/eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g);
    if (m) { const a = m.find(t => { try { return JSON.parse(atob(t.split('.')[1])).role === 'anon'; } catch { return false; } }); if (a) { anon = a; break; } }
  }

  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type || 'bearer',
    user_id: session.user?.id || null,
    supabase_url: 'https://sb.flowmusic.app',
    anon_key: anon,
    api_base: 'https://www.flowmusic.app/__api',
  };
  const r = await fetch('http://127.0.0.1:8799', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  console.log('session-receiver responded:', r.status, await r.text());
})();
*/
