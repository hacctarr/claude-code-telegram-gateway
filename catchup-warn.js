#!/usr/bin/env node
'use strict';
// UserPromptSubmit / SessionStart hook: one line when a phone branch is ahead of this desk
// session, so the user knows to run /catchup. Fires on every prompt while behind, by design;
// it self-clears because the gateway's rebind removes the sid from superseded.json. The fast
// path (sid not superseded) is two small JSON reads, well under per-prompt hook latency.
const fs = require('fs');
const path = require('path');
const { STATE_DIR, findTranscript, readJson } = require('./catchup.js');

// Count real phone turns in the fork region past the desk's fork-point size. The copied
// history is byte-similar, not byte-identical, so the offset is approximate; good enough for
// a warning, and cheap enough for a per-prompt hook (never re-reads the whole transcript).
function countPhoneTurns(forkFile, fromOffset) {
  let text;
  try {
    const size = fs.statSync(forkFile).size;
    if (size <= fromOffset) return 0;
    const buf = Buffer.alloc(size - fromOffset);
    const fd = fs.openSync(forkFile, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, fromOffset); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch (e) { return 0; }
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.type !== 'user' || o.isMeta || !o.message) continue;
    const c = o.message.content;
    const t = typeof c === 'string' ? c
      : (Array.isArray(c) ? (c.find((b) => b.type === 'text') || {}).text : null);
    if (t && !t.startsWith('<') && t.trim()) n++;
  }
  return n;
}

// forkedFrom only, no uuid fallback: the warn path runs per prompt and must stay cheap.
// Legacy links without the field stay silent; /catchup itself still resolves them.
function warnLine(sessionId, superseded, links, findForkFile) {
  const at = superseded[sessionId];
  if (at === undefined) return null;
  const forkId = Object.keys(links || {}).find((sid) => links[sid].forkedFrom === sessionId);
  if (!forkId) return null;
  const file = findForkFile(forkId);
  if (!file) return null;
  const n = countPhoneTurns(file, at);
  if (!n) return null;
  return `📱 Phone branch is ${n} turn${n === 1 ? '' : 's'} ahead. Run /catchup to pull them in.`;
}

// Idempotent merge into Claude Code settings. Lives here rather than in setup.js because
// setup.js runs its interactive flow at require time and so cannot be imported by tests.
function installWarnHook(settingsFile, gatewayDir) {
  const s = readJson(settingsFile, {});
  const command = `node "${path.join(gatewayDir, 'catchup-warn.js')}"`;
  s.hooks = s.hooks || {};
  for (const ev of ['UserPromptSubmit', 'SessionStart']) {
    const arr = (s.hooks[ev] = s.hooks[ev] || []);
    const present = arr.some((e) => (e.hooks || []).some((h) => h.command === command));
    if (!present) arr.push({ hooks: [{ type: 'command', command }] });
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2) + '\n');
  return settingsFile;
}

function main() {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let sid;
    try { sid = JSON.parse(input).session_id; } catch (e) { return; }
    if (!sid) return;
    const superseded = readJson(path.join(STATE_DIR, 'superseded.json'), {});
    if (superseded[sid] === undefined) return;   // fast path: most prompts exit here
    const links = readJson(path.join(STATE_DIR, 'links.json'), {});
    const line = warnLine(sid, superseded, links, (forkId) => findTranscript(forkId));
    if (line) process.stdout.write(line + '\n');
  });
}

if (require.main === module) main();
module.exports = { countPhoneTurns, warnLine, installWarnHook };
