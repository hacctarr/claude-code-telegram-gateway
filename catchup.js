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
const { summarizeToolInput } = require('./gateway.js');

const STATE_DIR = process.env.CLAUDE_GATEWAY_DIR || path.join(os.homedir(), '.claude-gateway');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function readTranscriptLines(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* partial trailing line */ }
  }
  return out;
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
    let overlap = false, extra = false;
    for (const o of readTranscriptLines(path.join(dir, sid + '.jsonl'))) {
      if (!o || !o.uuid) continue;
      if (deskUuids.has(o.uuid)) overlap = true; else extra = true;
      if (overlap && extra) return sid;
    }
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
function buildDigest(forkLines, deskUuids) {
  const parts = [];
  for (const o of forkLines) {
    if (!o || !o.uuid || deskUuids.has(o.uuid)) continue;
    parts.push(...renderDigestEntry(o));
  }
  return parts.join('\n\n');
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
async function run({
  sid,
  stateDir = STATE_DIR,
  projectsDir = PROJECTS_DIR,
  out = process.stdout,
  now = Date.now,
  writeMarkerFn = writeMarker,
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
  const forkFile = path.join(path.dirname(deskFile), forkId + '.jsonl');
  const forkSize = fs.statSync(forkFile).size;
  const deskLines = readTranscriptLines(deskFile);
  const digest = buildDigest(readTranscriptLines(forkFile), uuidSet(deskLines));
  if (!digest) {
    await say('nothing pending: the phone branch has no new turns.\n');
    return 0;
  }
  const repoDir = (deskLines.find((o) => o && o.cwd) || {}).cwd || process.cwd();
  await say(`--- phone branch ${forkId.slice(0, 8)} ---\n\n${digest}\n`);
  writeMarkerFn(sid, { forkId, forkSize, repoDir, ts: now() }, path.join(stateDir, 'catchup.json'));
  return 0;
}

if (require.main === module) {
  run({ sid: process.env.CLAUDE_CODE_SESSION_ID }).then((code) => { process.exitCode = code; });
}

module.exports = {
  STATE_DIR, PROJECTS_DIR, readJson,
  readTranscriptLines, uuidSet, findTranscript, findLinkedDescendant, renderDigestEntry, buildDigest,
  writeMarker, run,
};
