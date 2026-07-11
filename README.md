# lyria-api

Unofficial API wrapper for **Google Flow Music** (the Lyria-based music studio at
[flowmusic.app](https://www.flowmusic.app)). Generate songs from a text prompt,
iteratively **edit** them (remix / cover / extend / variation), build from an
**uploaded audio or image**, and download the result as **mp3 / m4a / wav** — via
a CLI, an HTTP server, or as a library. Runs **headless on a VPS**: it
authenticates with your saved session and refreshes the token itself.

> ⚠️ This talks to Flow Music's private web endpoints, not an official public API.
> It can break if Google changes them. Use your own account and respect Flow
> Music's terms of service.

---

## How it works

Flow Music has no public API, so the wrapper drives the same internal endpoints
the web app uses. The Producer is an **agent**: you send it messages and it calls
tools (`audio__create_song`, `audio__render_edit`, …) that produce clips.

| Step | Endpoint | Purpose |
|------|----------|---------|
| Auth | `Authorization: Bearer <supabase access_token>` | every call |
| Generate / edit | `POST /__api/conversation` | send prompt → `{ job_id }` |
| Stream | `GET /__api/messages/{job_id}/stream` | SSE with created `clip_id`s |
| Metadata | `POST /__api/clips` | render status + `wav_url` / `audio_url` |
| mp3 | `GET /__api/download/audio/{id}?format=mp3` | server-side transcode |
| Upload | `POST /__api/producer/upload[-audio]` | inspiration image / source audio |
| wav·m4a | `storage.googleapis.com/producer-app-public/clips/{id}.{wav\|m4a}` | public audio |

Auth is a Supabase session; the access token (1 h) is refreshed automatically
against `https://sb.flowmusic.app/auth/v1/token`, and a keep-alive keeps the
refresh-token chain warm so an idle service doesn't lapse.

```
src/
  config.js            env + endpoint config (loads .env natively)
  auth/session.js      load session, auto-refresh + keep-alive
  client/
    flowClient.js      low-level /__api calls (generate, clips, download, upload)
    sse.js             SSE stream parser
  services/
    generate.js        generate / edit (remix·cover·extend·variation) → clips
    download.js        clips → mp3/m4a/wav files on disk
  server.js            Express HTTP API
  cli.js               command-line interface
scripts/
  session-receiver.js  local receiver for session extraction
  extract-session.js   browser console snippet (instructions inside)
ecosystem.config.cjs   PM2 process definition
```

---

## Install

```bash
git clone https://github.com/magoflaco/lyria-api.git
cd lyria-api
npm install
cp .env.example .env        # optional; sane defaults otherwise
```

Requires Node ≥ 20.12.

### Capture your session (once)

Google login only works in a real browser, so the session is grabbed once from a
logged-in tab and stored in `secrets/session.json` (git-ignored).

1. Log in at <https://www.flowmusic.app> in Chrome.
2. Start the receiver: `node scripts/session-receiver.js`
3. Open DevTools → Console on the flowmusic.app tab, paste the snippet from
   [`scripts/extract-session.js`](scripts/extract-session.js), press Enter.
4. Stop the receiver (Ctrl+C). Verify: `node src/cli.js session`

The session file holds the Supabase access + refresh tokens. The wrapper refreshes
them itself, so once captured it keeps working unattended.

---

## CLI

```bash
# Generate (downloads every variation the Producer makes; default wav)
node src/cli.js generate "lofi chill beat, mellow piano, soft rain, 70 bpm, instrumental"
node src/cli.js generate "80s synthwave, driving bass, 110 bpm" --format mp3

# Iteratively edit an existing song (use the conversation + clip id from a generation)
node src/cli.js edit <conversationId> --song <clipId> --op remix   --prompt "drum and bass" --format mp3
node src/cli.js edit <conversationId> --song <clipId> --op cover    --prompt "acoustic folk"
node src/cli.js edit <conversationId> --song <clipId> --op extend
node src/cli.js edit <conversationId> --song <clipId> --op variation
node src/cli.js edit <conversationId> --song <clipId> --prompt "make the drums punchier"  # free-form

# Re-download an existing clip in any format
node src/cli.js download <clipId> --format mp3|m4a|wav

# Session status / refresh
node src/cli.js session
```

---

## HTTP server

```bash
npm start        # listens on PORT (default 8787)
```

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /health` | — | service + session status (no auth) |
| `POST /generate` | `{ prompt, format?, uploads? }` | **the audio** (see below) |
| `POST /edit` | `{ conversation_id, current_song_id?, operation?, prompt?, format? }` | **the audio** (see below) |
| `GET /clips/:id` | — | clip metadata + download links (JSON) |
| `GET /clips/:id/audio` | `?format=mp3\|wav\|m4a` | streams one clip's audio |
| `POST /upload/image` | multipart field `image` | `{ id, url, kind, media_type, name }` |
| `POST /upload/audio` | multipart field `audio` | `{ id, url, kind, media_type, name }` |

**`/generate` and `/edit` return JSON describing the clip(s).** The Producer may
make several variations; each is a **separate file** with its own `download_url`.
Fetch each one independently — no zips, no multipart.

- `format` is `mp3 | wav | m4a`; if omitted it defaults to `DEFAULT_FORMAT` (wav).
  `download_url` points at that format; `download.{mp3,m4a,wav}` has all three.
- Reuse `conversation_id` + a clip's `id` to keep editing.

```jsonc
// POST /generate {"prompt":"…","format":"mp3"}
{
  "title": "80 BPM Acoustic Sketch",
  "conversation_id": "0d144b0b-…",
  "count": 2,
  "clips": [
    { "id": "6e5d1c60-…", "title": "Acoustic Sketch 2", "duration_seconds": 103,
      "download_url": "http://HOST/clips/6e5d1c60-…/audio?format=mp3",
      "download": { "mp3": "…", "m4a": "…", "wav": "…" } },
    { "id": "d798bf06-…", "title": "Acoustic Sketch 1", "duration_seconds": 106,
      "download_url": "http://HOST/clips/d798bf06-…/audio?format=mp3", "download": { … } }
  ]
}
```

`operation` ∈ `variation | extend | remix | cover` (optionally refined with a
`prompt`), or omit `operation` and pass a free-form `prompt` for any tweak.

**Generate, then download every variation as its own file:**
```bash
curl -s -X POST http://localhost:8787/generate -H 'content-type: application/json' \
  -d '{"prompt":"funky disco groove, wah guitar, 118 bpm","format":"mp3"}' \
| jq -r '.clips[].download_url' \
| xargs -n1 curl -s -OJ      # -OJ keeps each clip's own filename
```

**Edit (remix) — reuse the conversation id from a previous call:**
```bash
curl -s -X POST http://localhost:8787/edit -H 'content-type: application/json' \
  -d '{"conversation_id":"…","current_song_id":"…","operation":"remix","prompt":"drum and bass","format":"wav"}' \
| jq -r '.clips[].download_url' | xargs -n1 curl -s -OJ
```

**Build from an uploaded image (inspiration):**
```bash
# 1) upload -> get a reference
REF=$(curl -s -X POST http://localhost:8787/upload/image -F image=@cover.jpg)
# 2) pass it in `uploads`
curl -s -X POST http://localhost:8787/generate -H 'content-type: application/json' \
  -d "{\"prompt\":\"a track inspired by this image\",\"uploads\":[$REF],\"format\":\"mp3\"}"
```
Audio works the same way via `POST /upload/audio` (source clip must be under ~4 min).

Set `API_KEY` in `.env` to require `Authorization: Bearer <API_KEY>` on every
endpoint except `/health`.

### Formats
- **wav** and **m4a** originate from public Google Cloud Storage; **mp3** is
  transcoded on demand. The API streams all three back to the caller.

### Variations
The Producer decides how many variations to make (usually 1–2, sometimes more).
The wrapper returns and downloads **all** of them — it never forces or drops any.

---

## Library use

```js
import { generateSong, editOperation } from './src/services/generate.js';
import { downloadClips } from './src/services/download.js';

const song = await generateSong('warm acoustic guitar, cozy folk, 80 bpm');
await downloadClips(song.clips, { format: 'mp3' });

// iterate on it
const remix = await editOperation('remix',
  { conversationId: song.conversationId, currentSongId: song.clips[0].id, prompt: 'lo-fi' });
await downloadClips(remix.clips, { format: 'wav' });
```

---

## Deploy (VPS)

Runs headless anywhere. Example with PM2:

```bash
git clone https://github.com/magoflaco/lyria-api.git ~/lyria-api && cd ~/lyria-api
npm install --omit=dev
# copy your captured session over from your laptop:
#   scp secrets/session.json user@host:~/lyria-api/secrets/
cat > .env <<'ENV'
PORT=3003
API_KEY=change-me-to-a-long-random-string
DEFAULT_FORMAT=wav
ENV
pm2 start ecosystem.config.cjs
pm2 save          # persist across reboots (with `pm2 startup` configured once)
```

Make sure the port is open in your firewall / cloud security group.

> The live deployment's host, port and API key are kept in `DEPLOY.md` /
> `secrets/DEPLOY.md`, which are git-ignored and never pushed.

**Session ownership:** Supabase refresh tokens rotate on use. If the *same* login
is refreshed from both a browser and the server, reuse-detection can revoke the
session. Let the server own the captured session; if you keep using the web app,
sign in fresh there. If the server session ever dies, re-capture and re-copy
`secrets/session.json`, then `pm2 restart lyria-api`.

## License

MIT
