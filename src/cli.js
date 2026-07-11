#!/usr/bin/env node
// Simple CLI for testing the wrapper without the HTTP server.
//
//   node src/cli.js generate "lofi chill beat, mellow piano, 70 bpm"  [--format wav|m4a] [--no-download]
//   node src/cli.js download <clipId> [--format wav|m4a]
//   node src/cli.js session                 # show session status / force refresh check

import { FlowClient } from './client/flowClient.js';
import { generateSong } from './services/generate.js';
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
    else if (a === '--variations') flags.variations = Number(args[++i]);
    else rest.push(a);
  }
  return { flags, rest };
}

async function cmdGenerate(args) {
  const { flags, rest } = parseFlags(args);
  const prompt = rest.join(' ').trim();
  if (!prompt) throw new Error('Usage: cli.js generate "<prompt>" [--format wav|m4a] [--no-download]');
  const format = flags.format || config.defaultFormat;
  const variations = flags.variations ?? 2;

  console.log(`\n🎵  Prompt: ${prompt}`);
  console.log(`⏳  Generating ${variations} variation(s) (this takes ~30-60s each)...`);

  const result = await generateSong(prompt, {
    variations,
    onGeneration: ({ have, want }) => process.stdout.write(`\r   generated ${have}/${want} clips...      `),
    onProgress: ({ ready, total }) => process.stdout.write(`\r   rendered ${ready}/${total} clips        `),
  });

  console.log(`\n✅  "${result.title || 'Untitled'}" — ${result.clips.length} variations`);
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
    case 'download': return cmdDownload(args);
    case 'session': return cmdSession();
    default:
      console.log('Commands: generate | download | session');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
