#!/usr/bin/env node
'use strict';
// UserPromptSubmit / SessionStart hook: one line when a phone branch is ahead of this desk
// session, so the user knows to run /catchup. Fires on every prompt while behind, by design;
// it self-clears because the gateway's rebind removes the sid from superseded.json. The fast
// path (sid not superseded) is two small JSON reads, well under per-prompt hook latency.
const fs = require('fs');
const path = require('path');
const { STATE_DIR, findTranscript, readJson } = require('./catchup.js');

// Count real phone turns in the fork region past the desk's fork-point size. The offset is
// derived from the DESK file's size but indexes the FORK file, and copied history is
// byte-similar rather than byte-identical, so it lands mid-record routinely. Reading straight
// from it truncates that record, JSON.parse rejects the fragment, and a real phone turn
// disappears from the count without any error. Rewind to the preceding newline so the record
// containing the offset is read whole. The rewind never crosses more than one record, so it
// cannot re-count history the desk already ingested.
function countPhoneTurns(forkFile, fromOffset) {
  let text;
  let skipFirst = false;
  try {
    const size = fs.statSync(forkFile).size;
    if (size <= fromOffset) return 0;
    const fd = fs.openSync(forkFile, 'r');
    let start = fromOffset;
    try {
      // Rewind to the start of the record containing the offset, so it is read whole rather
      // than as an unparseable fragment. Bounded by one record length, so still cheap enough
      // for a per-prompt hook.
      const probe = Buffer.alloc(1);
      while (start > 0) {
        fs.readSync(fd, probe, 0, 1, start - 1);
        if (probe[0] === 0x0a) break;
        start--;
      }
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      // The rewound record is desk history when it ends at or before the fork point; it is a
      // genuine phone turn only when it extends past it. Byte position alone cannot tell these
      // apart, since both sit "before" the offset.
      skipFirst = start < fromOffset
        && start + Buffer.byteLength(text.split('\n')[0], 'utf8') < fromOffset;
    } finally { fs.closeSync(fd); }
  } catch (e) { return 0; }
  let n = 0;
  let first = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (first) { first = false; if (skipFirst) continue; }
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
