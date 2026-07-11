#!/usr/bin/env node
// Simple CLI for testing the wrapper without the HTTP server.
//
//   node src/cli.js generate "lofi chill beat, mellow piano, 70 bpm"  [--format wav|m4a] [--no-download]
//   node src/cli.js download <clipId> [--format wav|m4a]
//   node src/cli.js session                 # show session status / force refresh check

import { FlowClient } from './client/flowClient.js';
import { generateSong, editSong, editOperation } from './services/generate.js';
import { downloadClips, downloadClip } from './services/download.js';
import { defaultSession } from './auth/session.js';
import { config } from './config.js';

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format') flags.format = args[++i];
    else if (a === '--no-download') flags.noDownload = true;
    else if (a === '--dir') flags.dir = args[++i];
    else if (a === '--song') flags.song = args[++i];
    else if (a === '--op' || a === '--operation') flags.operation = args[++i];
    else if (a === '--prompt') flags.prompt = args[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

async function cmdGenerate(args) {
  const { flags, rest } = parseFlags(args);
  const prompt = rest.join(' ').trim();
  if (!prompt) throw new Error('Usage: cli.js generate "<prompt>" [--format wav|m4a] [--no-download]');
  const format = flags.format || config.defaultFormat;

  console.log(`\n🎵  Prompt: ${prompt}`);
  console.log('⏳  Generating (this takes ~30-60s)...');

  const result = await generateSong(prompt, {
    onProgress: ({ ready, total }) => process.stdout.write(`\r   rendered ${ready}/${total} clips        `),
  });

  console.log(`\n✅  "${result.title || 'Untitled'}" — ${result.clips.length} variation(s)  [conversation ${result.conversationId}]`);
  for (const c of result.clips) {
    const dur = c.duration?.value ? `${Math.round(Number(c.duration.value))}s` : '?';
    console.log(`    • ${c.id}  (${dur})  ${c.title || ''}`);
  }

  if (flags.noDownload) {
    console.log('\n(skipping download; --no-download set)');
    return;
  }

  console.log(`\n⬇️   Downloading ${format.toUpperCase()} files to ${config.downloadDir} ...`);
  const files = await downloadClips(result.clips, { format, dir: flags.dir });
  for (const f of files) {
    console.log(`    ✔ ${f.path}  (${(f.bytes / 1e6).toFixed(2)} MB)`);
  }
}

async function cmdEdit(args) {
  const { flags, rest } = parseFlags(args);
  const conversationId = rest[0];
  if (!conversationId) {
    throw new Error(
      'Usage: cli.js edit <conversationId> --song <clipId> [--op variation|extend|remix|cover] [--prompt "..."] [--format wav|mp3|m4a]'
    );
  }
  const format = flags.format || config.defaultFormat;
  const op = flags.operation;
  const prompt = flags.prompt || rest.slice(1).join(' ').trim() || undefined;

  console.log(`\n✏️   Editing in conversation ${conversationId}${op ? ` (${op})` : ''}`);
  console.log('⏳  Working (this takes ~30-60s)...');

  const doEdit = op
    ? editOperation(op, { conversationId, currentSongId: flags.song, prompt })
    : editSong({ conversationId, currentSongId: flags.song, prompt });
  const result = await doEdit;

  console.log(`\n✅  "${result.title || 'Untitled'}" — ${result.clips.length} clip(s)`);
  for (const c of result.clips) console.log(`    • ${c.id}  ${c.title || ''}`);

  if (flags.noDownload) return;
  console.log(`\n⬇️   Downloading ${format.toUpperCase()} to ${flags.dir || config.downloadDir} ...`);
  const files = await downloadClips(result.clips, { format, dir: flags.dir });
  for (const f of files) console.log(`    ✔ ${f.path}  (${(f.bytes / 1e6).toFixed(2)} MB)`);
}

async function cmdDownload(args) {
  const { flags, rest } = parseFlags(args);
  const clipId = rest[0];
  if (!clipId) throw new Error('Usage: cli.js download <clipId> [--format wav|m4a]');
  const format = flags.format || config.defaultFormat;
  const client = new FlowClient();
  const clip = await client.getClip(clipId);
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const f = await downloadClip(clip, { format, dir: flags.dir });
  console.log(`✔ ${f.path}  (${(f.bytes / 1e6).toFixed(2)} MB)`);
}

async function cmdSession() {
  const s = defaultSession.load();
  const now = Math.floor(Date.now() / 1000);
  console.log('Session file :', defaultSession.sessionFile);
  console.log('User id      :', s.user_id || '(unknown)');
  console.log('Expires at   :', new Date((s.expires_at || 0) * 1000).toISOString());
  console.log('Expired?     :', defaultSession.isExpired());
  if (defaultSession.isExpired()) {
    console.log('Refreshing...');
    await defaultSession.refresh();
    console.log('New expiry   :', new Date(defaultSession.session.expires_at * 1000).toISOString());
  } else {
    console.log('Seconds left :', (s.expires_at || 0) - now);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'generate': return cmdGenerate(args);
    case 'edit': return cmdEdit(args);
    case 'download': return cmdDownload(args);
    case 'session': return cmdSession();
    default:
      console.log('Commands: generate | edit | download | session');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
