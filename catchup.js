#!/usr/bin/env node
'use strict';
// Desk catch-up, read-only side: build a verbatim digest of the phone branch that forked off
// this desk session, print it (the invoking Claude session ingests it as tool output), then
// write a request marker the gateway daemon consumes to rebind the Telegram topic. Only the
// daemon may mutate links/superseded state: it holds both in memory and persists over external
// edits, so a direct edit here would silently revert.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { summarizeToolInput } = require('./gateway.js');

const STATE_DIR = process.env.CLAUDE_GATEWAY_DIR || path.join(os.homedir(), '.claude-gateway');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function parseTranscript(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* partial trailing line */ }
  }
  return out;
}

function readTranscriptLines(file) {
  return parseTranscript(fs.readFileSync(file, 'utf8'));
}

// Size is derived from the bytes read, never stat'd separately: a phone turn landing between a
// stat and the read would make the recorded size stale-small relative to the digest, and the
// daemon would decline a rebind whose digest was in fact complete.
function readTranscriptWithSize(file) {
  const buf = fs.readFileSync(file);
  return { lines: parseTranscript(buf.toString('utf8')), size: buf.length };
}

// Feed a transcript's records to `onRecord` in chunks, stopping as soon as it returns false.
// Transcripts here reach hundreds of MB, so a scan that only needs uuids must never materialize
// the file: reading one 276 MB candidate whole cost more than the rest of the lookup combined.
function scanTranscript(file, onRecord, chunkBytes = 1 << 20) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return; }
  const buf = Buffer.alloc(chunkBytes);
  let rest = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (!n) break;
      const text = rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      rest = lines.pop();                      // trailing partial line carries to the next chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (onRecord(o) === false) return;
      }
    }
    if (rest.trim()) { try { onRecord(JSON.parse(rest)); } catch (e) { /* partial trailing line */ } }
  } finally { fs.closeSync(fd); }
}

function uuidSet(lines) {
  const s = new Set();
  for (const o of lines) if (o && o.uuid) s.add(o.uuid);
  return s;
}

function findTranscript(sid, projectsDir = PROJECTS_DIR) {
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, sid + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* no projects dir */ }
  return null;
}

// The linked descendant leaf. Fork-of-fork chains resolve automatically because the gateway
// moves the link (and forkedFrom) to each new fork, so there is exactly one LINKED descendant.
// forkedFrom is recorded at fork time going forward; the uuid-overlap test covers links written
// before that field existed. Same-project-dir only: a fork shares its parent's cwd.
function findLinkedDescendant(deskSid, deskFile, links) {
  const dir = path.dirname(deskFile);
  const candidates = Object.keys(links || {}).filter((sid) =>
    sid !== deskSid && fs.existsSync(path.join(dir, sid + '.jsonl')));
  const byField = candidates.find((sid) => links[sid].forkedFrom === deskSid);
  if (byField) return byField;
  const deskUuids = uuidSet(readTranscriptLines(deskFile));
  for (const sid of candidates) {
    // --fork-session copies history from the start, so a descendant's FIRST uuid-bearing record
    // is one the desk has. A candidate failing that cannot be a descendant, and stopping there
    // is what keeps the scan cheap: on this corpus all 146 candidates are rejected on that
    // record, one of them a 276 MB file that otherwise costs 2 s to read only to prove a
    // negative. Leading records without a uuid are headers/summaries and are skipped, not
    // treated as the head: that distinction is the whole difference, since every transcript
    // here opens with one.
    let overlap = false, extra = false, decided = false;
    scanTranscript(path.join(dir, sid + '.jsonl'), (o) => {
      if (!o || !o.uuid) return true;
      const known = deskUuids.has(o.uuid);
      if (!decided) { decided = true; if (!known) return false; }
      if (known) overlap = true; else extra = true;
      return !(overlap && extra);
    });
    if (overlap && extra) return sid;
  }
  return null;
}

// One transcript record to digest lines. User prompts stay VERBATIM (the whole point of the
// digest); the mirror's renderTranscriptLine collapses whitespace for one-line Telegram posts,
// which is why this is its own renderer rather than a reuse. Classification matches the mirror:
// meta lines and command envelopes are noise, tool calls collapse to one-line traces.
function renderDigestEntry(o) {
  if (!o || typeof o !== 'object' || o.isMeta) return [];
  if (o.type === 'user' && o.message) {
    const cnt = o.message.content;
    const t = typeof cnt === 'string' ? cnt
      : (Array.isArray(cnt) ? (cnt.find((b) => b.type === 'text') || {}).text : null);
    if (t && !t.startsWith('<') && t.trim()) return [`📱 phone: ${t.trim()}`];
    return [];
  }
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const out = [];
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push(b.text.trim());
      else if (b.type === 'tool_use') {
        const s = summarizeToolInput(b.name, b.input);
        out.push(`🔧 ${b.name}${s ? ': ' + s : ''}`);
      }
    }
    return out;
  }
  return [];
}

// The new phone turns are exactly the fork entries whose uuid the desk file lacks
// (--fork-session copies history with uuids preserved). Records without a uuid are
// headers/summaries, never turns, so they are skipped rather than treated as new.
// `shown` carries the uuids a previous declined run already printed: the desk transcript records
// that digest only as prose under a fresh uuid, so without this a retry re-prints everything.
// Returns the rendered uuids alongside the text so the marker can record what was shown.
function buildDigest(forkLines, deskUuids, shown = new Set()) {
  const parts = [];
  const uuids = [];
  for (const o of forkLines) {
    if (!o || !o.uuid || deskUuids.has(o.uuid) || shown.has(o.uuid)) continue;
    const rendered = renderDigestEntry(o);
    if (!rendered.length) continue;
    parts.push(...rendered);
    uuids.push(o.uuid);
  }
  return { text: parts.join('\n\n'), uuids };
}

// Merge-written like resume.json: concurrent catchups in different repos must not clobber.
function writeMarker(deskSid, entry, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const m = readJson(file, {});
  m[deskSid] = entry;
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
}

// Order is terminal-state discipline: digest printed and FLUSHED, then the marker, then exit.
// The rebind trigger must not exist until the digest has fully left the process, so a crash at
// any point before the marker leaves gateway state unchanged and a re-run starts over cleanly.
// (The desk jsonl only grows after the Bash tool returns, which is after both.)
// Same probe doctor.sh uses. Failing open (assuming a daemon is up) is the safe direction: a
// spurious warning on a healthy setup is worse than staying quiet, and the marker is written
// either way, so a missed warning costs nothing the user cannot see by re-running.
function isGatewayRunning() {
  try {
    return execFileSync('pgrep', ['-f', 'gateway\\.js'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
  } catch (e) { return true; }
}

async function run({
  sid,
  stateDir = STATE_DIR,
  projectsDir = PROJECTS_DIR,
  out = process.stdout,
  now = Date.now,
  writeMarkerFn = writeMarker,
  gatewayAlive = isGatewayRunning,
} = {}) {
  const say = (t) => new Promise((res) => out.write(t, res));
  if (!sid) {
    await say('catchup: CLAUDE_CODE_SESSION_ID is not set. Run this from inside a Claude Code session.\n');
    return 1;
  }
  const deskFile = findTranscript(sid, projectsDir);
  if (!deskFile) {
    await say(`catchup: no transcript found for session ${sid}.\n`);
    return 1;
  }
  const superseded = readJson(path.join(stateDir, 'superseded.json'), {});
  if (superseded[sid] === undefined) {
    await say('nothing pending: no phone branch is ahead of this session.\n');
    return 0;
  }
  const links = readJson(path.join(stateDir, 'links.json'), {});
  const forkId = findLinkedDescendant(sid, deskFile, links);
  if (!forkId) {
    await say('nothing pending: no phone branch is ahead of this session.\n');
    return 0;
  }
  const markerFile = path.join(stateDir, 'catchup.json');
  // A declined entry is the record of a run whose rebind was refused because a phone turn landed
  // mid-catch-up. Its uuids are already in the desk context, so this run picks up only the rest.
  const prior = readJson(markerFile, {})[sid];
  const shown = new Set(prior && prior.declined && Array.isArray(prior.shownUuids) ? prior.shownUuids : []);
  const forkFile = path.join(path.dirname(deskFile), forkId + '.jsonl');
  const { lines: forkLines, size: forkSize } = readTranscriptWithSize(forkFile);
  const deskLines = readTranscriptLines(deskFile);
  const digest = buildDigest(forkLines, uuidSet(deskLines), shown);
  if (!digest.text) {
    await say('nothing pending: the phone branch has no new turns.\n');
    return 0;
  }
  const repoDir = (deskLines.find((o) => o && o.cwd) || {}).cwd || process.cwd();
  await say(`--- phone branch ${forkId.slice(0, 8)} ---\n\n${digest.text}\n`);
  // The marker is a request to the daemon, which alone can rebind the topic. With no daemon
  // running it simply ages out after CATCHUP_STALE_MS with nothing said, and the run looks
  // identical to one that worked: the digest lands in context either way, so the only visible
  // difference is a topic that never comes back. Say so while the user can still act on it.
  if (!gatewayAlive()) {
    await say('\n⚠️  The gateway is not running, so this topic will not rebind to the desk. ' +
      'The turns above are in context regardless. Start the gateway and re-run /catchup to rebind.\n');
  }
  writeMarkerFn(sid, {
    forkId, forkSize, repoDir, ts: now(),
    shownUuids: [...shown, ...digest.uuids],
  }, markerFile);
  return 0;
}

if (require.main === module) {
  run({ sid: process.env.CLAUDE_CODE_SESSION_ID }).then((code) => { process.exitCode = code; });
}

module.exports = {
  STATE_DIR, PROJECTS_DIR, readJson,
  parseTranscript, readTranscriptLines, readTranscriptWithSize, scanTranscript,
  uuidSet, findTranscript, findLinkedDescendant, renderDigestEntry, buildDigest,
  writeMarker, run,
};
