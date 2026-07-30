# Desk Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/catchup` command that pulls phone-branch turns into an open desk session (verbatim digest), then has the gateway daemon rebind the Telegram topic to the desk session and supersede the fork.

**Architecture:** Three pieces per the spec (`docs/superpowers/specs/2026-07-30-desk-catchup-design.md`): `catchup.js` at the repo root builds a uuid-diff digest and writes a request marker (digest printed and flushed before the marker exists); `gateway.js` consumes the marker at the top of `pollTick` and performs the rebind (the inverse of `driveTurn`'s fork block); a thin `commands/catchup.md` slash command drives it. Phase 2 adds `catchup-warn.js` as an opt-in UserPromptSubmit/SessionStart hook.

**Tech Stack:** Node.js >= 18, CommonJS, zero runtime dependencies, `node:test`.

## Global Constraints

- Node `>=18` (package.json `engines`), CommonJS `require`, `"dependencies": {}` stays empty.
- Test runner: `npm test` runs `node --test test/*.test.js modules/*.test.js examples/modules/*.test.js`. New test files under `test/` are picked up automatically.
- No em dashes anywhere: code comments, log strings, user-facing strings, markdown. Use a comma, colon, period, or parentheses.
- Every file ends with a newline.
- Gateway state lives in `STATE_DIR` (`process.env.CLAUDE_GATEWAY_DIR || ~/.claude-gateway`); transcripts under `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`.
- Tests must never touch the real `~/.claude-gateway` or `~/.claude`: every new function takes explicit file/dir parameters with production defaults, and tests pass `fs.mkdtempSync` fixtures.
- Comments state constraints or rationale only, matching the existing comment density in `gateway.js`. Never narrate what the next line does.
- No new config keys.
- Marker file: `<STATE_DIR>/catchup.json`, shape `{ "<deskSid>": { forkId, forkSize, repoDir, ts } }`, merge-written; entries older than 10 minutes are dropped on read.
- Known spec deviation (code wins over the spec's wording): the shell hook is installed by `install-service.sh`, not `setup.js`, so the `/catchup` command install goes in `install-service.sh` (Task 7). `setup.js` keeps the phase-2 opt-in prompt because it is the interactive script (Task 8).

## File Structure

- Create `catchup.js` (repo root, sibling of `resume-hook.js`): read-only digest builder + marker writer. Exports pure helpers; CLI entry guarded by `require.main`.
- Modify `gateway.js`: record `forkedFrom` at fork time; add marker readers + `executeCatchupRebind` + `consumeCatchupRequests`; skip the re-topic path for sessions with a pending catch-up entry.
- Create `commands/catchup.md`: slash-command source with a `{{GATEWAY_DIR}}` placeholder.
- Modify `install-service.sh`: install the command to `~/.claude/commands/catchup.md` with the placeholder resolved.
- Create `catchup-warn.js` (repo root): phase-2 hook; also exports `installWarnHook` (setup.js runs as an unguarded IIFE, so testable helpers cannot live there).
- Modify `setup.js`: opt-in prompt that calls `installWarnHook`.
- Modify `package.json`: add `catchup.js`, `catchup-warn.js`, `commands/` to `files`; version bump.
- Create `test/catchup.test.js`, `test/catchup-consume.test.js`, `test/catchup-warn.test.js`.

---

### Task 1: catchup.js digest core

**Files:**
- Create: `catchup.js`
- Test: `test/catchup.test.js`

**Interfaces:**
- Consumes: `summarizeToolInput(name, input)` from `./gateway.js` (already exported; requiring gateway.js is safe, boot is behind `require.main === module`).
- Produces (later tasks rely on these exact names):
  - `readTranscriptLines(file) -> object[]` (parsed jsonl records, blank/partial lines skipped)
  - `uuidSet(lines) -> Set<string>` (from each record's `uuid` field)
  - `findTranscript(sid, projectsDir) -> string|null` (glob `<projectsDir>/*/<sid>.jsonl`)
  - `renderDigestEntry(record) -> string[]`
  - `buildDigest(forkLines, deskUuids) -> string`
  - Constants: `STATE_DIR`, `PROJECTS_DIR`

- [ ] **Step 1: Write the failing tests**

Create `test/catchup.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const c = require('../catchup.js');

// Fixture mirrors real transcript shape: two project dirs, a desk file, and a fork
// carrying the desk's copied history (same uuids) plus new phone turns.
const J = (o) => JSON.stringify(o) + '\n';
const DESK_LINES = [
  { uuid: 'u1', type: 'user', cwd: '/Users/me/repo', message: { role: 'user', content: 'first desk prompt' } },
  { uuid: 'u2', type: 'assistant', message: { content: [{ type: 'text', text: 'desk reply' }] } },
];
const FORK_NEW = [
  { uuid: 'u3', type: 'user', message: { role: 'user', content: 'phone: check  the\ndeploy' } },
  { uuid: 'u4', type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
    { type: 'text', text: 'All clean.' },
  ] } },
  { uuid: 'u5', type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
  { uuid: 'u6', type: 'user', message: { role: 'user', content: '<command-name>/foo</command-name>' } },
  { uuid: 'u7', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'big output' }] } },
];

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
  const projectsDir = path.join(root, 'projects');
  const proj = path.join(projectsDir, '-Users-me-repo');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, '-Users-me-other'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'desk-sid.jsonl'), DESK_LINES.map(J).join(''));
  fs.writeFileSync(path.join(proj, 'fork-sid.jsonl'), DESK_LINES.concat(FORK_NEW).map(J).join(''));
  return { root, projectsDir, proj };
}

test('readTranscriptLines: parses records, skips blank and malformed lines', () => {
  const { proj } = mkFixture();
  const file = path.join(proj, 'weird.jsonl');
  fs.writeFileSync(file, J({ uuid: 'a' }) + '\n' + 'not json\n' + J({ uuid: 'b' }));
  const lines = c.readTranscriptLines(file);
  assert.deepEqual(lines.map((o) => o.uuid), ['a', 'b']);
});

test('uuidSet: collects uuid fields, ignores records without one', () => {
  const s = c.uuidSet([{ uuid: 'a' }, { type: 'summary' }, { uuid: 'b' }]);
  assert.deepEqual([...s].sort(), ['a', 'b']);
});

test('findTranscript: locates a session file across project dirs', () => {
  const { projectsDir, proj } = mkFixture();
  assert.equal(c.findTranscript('desk-sid', projectsDir), path.join(proj, 'desk-sid.jsonl'));
  assert.equal(c.findTranscript('nope', projectsDir), null);
});

test('renderDigestEntry: user text is verbatim with the phone prefix', () => {
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[0]), ['📱 phone: phone: check  the\ndeploy']);
});

test('renderDigestEntry: assistant text verbatim, tool calls as one-line traces', () => {
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[1]), ['🔧 Bash: git status', 'All clean.']);
});

test('renderDigestEntry: meta lines, command envelopes, tool results excluded', () => {
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[2]), []);
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[3]), []);
  assert.deepEqual(c.renderDigestEntry(FORK_NEW[4]), []);
});

test('buildDigest: only entries whose uuid the desk file lacks', () => {
  const { proj } = mkFixture();
  const deskUuids = c.uuidSet(c.readTranscriptLines(path.join(proj, 'desk-sid.jsonl')));
  const digest = c.buildDigest(c.readTranscriptLines(path.join(proj, 'fork-sid.jsonl')), deskUuids);
  assert.equal(digest,
    '📱 phone: phone: check  the\ndeploy\n\n🔧 Bash: git status\n\nAll clean.');
  assert.ok(!digest.includes('desk reply'), 'copied history must not appear');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catchup.test.js`
Expected: FAIL with `Cannot find module '../catchup.js'`

- [ ] **Step 3: Write the implementation**

Create `catchup.js`:

```js
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

module.exports = {
  STATE_DIR, PROJECTS_DIR, readJson,
  readTranscriptLines, uuidSet, findTranscript, renderDigestEntry, buildDigest,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catchup.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS (no regressions; requiring gateway.js from catchup.js must not break anything)

```bash
git -C /Users/marc/telegram_gateway add catchup.js test/catchup.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(catchup): digest core, uuid-diff selection and verbatim rendering"
```

---

### Task 2: catchup.js descendant resolution

**Files:**
- Modify: `catchup.js`
- Test: `test/catchup.test.js`

**Interfaces:**
- Consumes: `readTranscriptLines`, `uuidSet` (Task 1).
- Produces: `findLinkedDescendant(deskSid, deskFile, links) -> string|null`. `links` is the parsed `links.json` object (`{ sid: { chatId, threadId, forkedFrom?, ... } }`). Fast path: a link whose `forkedFrom === deskSid`. Fallback for pre-existing links: a linked session in the same project dir whose uuid set both intersects the desk file's and contains uuids the desk file lacks.

- [ ] **Step 1: Write the failing tests**

Append to `test/catchup.test.js`:

```js
test('findLinkedDescendant: forkedFrom fast path wins without reading transcripts', () => {
  const { proj } = mkFixture();
  const links = { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } };
  assert.equal(
    c.findLinkedDescendant('desk-sid', path.join(proj, 'desk-sid.jsonl'), links),
    'fork-sid');
});

test('findLinkedDescendant: legacy links resolve via uuid overlap', () => {
  const { proj } = mkFixture();
  const links = { 'fork-sid': { chatId: '-1', threadId: 5 } };
  assert.equal(
    c.findLinkedDescendant('desk-sid', path.join(proj, 'desk-sid.jsonl'), links),
    'fork-sid');
});

test('findLinkedDescendant: a linked session with no shared history is not a descendant', () => {
  const { proj } = mkFixture();
  fs.writeFileSync(path.join(proj, 'fresh-sid.jsonl'),
    J({ uuid: 'x1', type: 'user', message: { role: 'user', content: 'unrelated /new session' } }));
  const links = { 'fresh-sid': { chatId: '-1', threadId: 9 } };
  assert.equal(
    c.findLinkedDescendant('desk-sid', path.join(proj, 'desk-sid.jsonl'), links),
    null);
});

test('findLinkedDescendant: candidates outside the desk project dir are ignored', () => {
  const { projectsDir, proj } = mkFixture();
  const other = path.join(projectsDir, '-Users-me-other');
  fs.copyFileSync(path.join(proj, 'fork-sid.jsonl'), path.join(other, 'else-sid.jsonl'));
  const links = { 'else-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } };
  assert.equal(
    c.findLinkedDescendant('desk-sid', path.join(proj, 'desk-sid.jsonl'), links),
    null);
});

test('findLinkedDescendant: fork-of-fork chain resolves to the linked leaf', () => {
  // The gateway moves the link to each new fork, so in a desk -> fork1 -> fork2 chain only
  // fork2 is linked; fork1 sits unlinked in superseded state and must not be considered.
  const { proj } = mkFixture();
  fs.copyFileSync(path.join(proj, 'fork-sid.jsonl'), path.join(proj, 'fork1-sid.jsonl'));
  const fork2 = DESK_LINES.concat(FORK_NEW, [
    { uuid: 'u8', type: 'user', message: { role: 'user', content: 'second phone reply' } },
  ]);
  fs.writeFileSync(path.join(proj, 'fork2-sid.jsonl'), fork2.map(J).join(''));
  const links = { 'fork2-sid': { chatId: '-1', threadId: 5, forkedFrom: 'fork1-sid' } };
  assert.equal(
    c.findLinkedDescendant('desk-sid', path.join(proj, 'desk-sid.jsonl'), links),
    'fork2-sid', 'uuid fallback finds the leaf even though forkedFrom names the middle fork');
});

test('findLinkedDescendant: never returns the desk session itself', () => {
  const { proj } = mkFixture();
  const links = { 'desk-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } };
  assert.equal(
    c.findLinkedDescendant('desk-sid', path.join(proj, 'desk-sid.jsonl'), links),
    null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catchup.test.js`
Expected: FAIL with `c.findLinkedDescendant is not a function`

- [ ] **Step 3: Write the implementation**

Add to `catchup.js` (below `findTranscript`) and export it:

```js
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
```

Add `findLinkedDescendant` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catchup.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/marc/telegram_gateway add catchup.js test/catchup.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(catchup): linked-descendant resolution, forkedFrom fast path with uuid fallback"
```

---

### Task 3: catchup.js marker write, run() ordering, CLI entry

**Files:**
- Modify: `catchup.js`
- Test: `test/catchup.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces:
  - `writeMarker(deskSid, entry, file) -> void` (merge-write; `entry = { forkId, forkSize, repoDir, ts }`)
  - `run({ sid, stateDir, projectsDir, out, now, writeMarkerFn }) -> Promise<number>` (exit code; all deps default to production values)
  - CLI entry: `node catchup.js` runs `run({ sid: process.env.CLAUDE_CODE_SESSION_ID })` and sets `process.exitCode`.
  - Every "nothing to do" message starts with the literal string `nothing pending` (the command file and daemon docs key on it).

- [ ] **Step 1: Write the failing tests**

Append to `test/catchup.test.js`:

```js
test('writeMarker: merge-writes so concurrent catchups in other repos survive', () => {
  const { root } = mkFixture();
  const file = path.join(root, 'catchup.json');
  c.writeMarker('sid-a', { forkId: 'f-a', forkSize: 10, repoDir: '/r/a', ts: 1 }, file);
  c.writeMarker('sid-b', { forkId: 'f-b', forkSize: 20, repoDir: '/r/b', ts: 2 }, file);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(m).sort(), ['sid-a', 'sid-b']);
  assert.equal(m['sid-a'].forkId, 'f-a');
});

// run() needs gateway state files alongside the fixture transcripts.
function mkStateDir(root, { superseded = {}, links = {} } = {}) {
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'superseded.json'), JSON.stringify(superseded));
  fs.writeFileSync(path.join(stateDir, 'links.json'), JSON.stringify(links));
  return stateDir;
}

function fakeOut(events) {
  return { write(text, cb) { events.push({ ev: 'out', text }); if (cb) cb(); return true; } };
}

test('run: no session id is a clear error, exit 1, no marker', async () => {
  const { root, projectsDir } = mkFixture();
  const stateDir = mkStateDir(root);
  const events = [];
  const code = await c.run({ sid: undefined, stateDir, projectsDir, out: fakeOut(events) });
  assert.equal(code, 1);
  assert.match(events[0].text, /CLAUDE_CODE_SESSION_ID/);
  assert.ok(!fs.existsSync(path.join(stateDir, 'catchup.json')));
});

test('run: not superseded prints nothing pending, exit 0, no marker', async () => {
  const { root, projectsDir } = mkFixture();
  const stateDir = mkStateDir(root, { links: { 'fork-sid': { forkedFrom: 'desk-sid' } } });
  const events = [];
  const code = await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut(events) });
  assert.equal(code, 0);
  assert.match(events[0].text, /^nothing pending/);
  assert.ok(!fs.existsSync(path.join(stateDir, 'catchup.json')));
});

test('run: no linked descendant prints nothing pending, no marker', async () => {
  const { root, projectsDir } = mkFixture();
  const stateDir = mkStateDir(root, { superseded: { 'desk-sid': 100 } });
  const events = [];
  const code = await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut(events) });
  assert.equal(code, 0);
  assert.match(events[0].text, /^nothing pending/);
  assert.ok(!fs.existsSync(path.join(stateDir, 'catchup.json')));
});

test('run: digest fully written before the marker exists, marker fields correct', async () => {
  const { root, projectsDir, proj } = mkFixture();
  const stateDir = mkStateDir(root, {
    superseded: { 'desk-sid': 100 },
    links: { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } },
  });
  const events = [];
  const code = await c.run({
    sid: 'desk-sid', stateDir, projectsDir, out: fakeOut(events), now: () => 12345,
    writeMarkerFn: (sid, entry, file) => { events.push({ ev: 'marker' }); c.writeMarker(sid, entry, file); },
  });
  assert.equal(code, 0);
  const kinds = events.map((e) => e.ev);
  assert.equal(kinds[kinds.length - 1], 'marker', 'marker is the terminal write');
  assert.ok(kinds.slice(0, -1).every((k) => k === 'out'), 'all output precedes the marker');
  const digestText = events.filter((e) => e.ev === 'out').map((e) => e.text).join('');
  assert.ok(digestText.includes('📱 phone:'), 'digest contains the phone turns');
  const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'catchup.json'), 'utf8'));
  assert.equal(m['desk-sid'].forkId, 'fork-sid');
  assert.equal(m['desk-sid'].forkSize, fs.statSync(path.join(proj, 'fork-sid.jsonl')).size);
  assert.equal(m['desk-sid'].repoDir, '/Users/me/repo');
  assert.equal(m['desk-sid'].ts, 12345);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catchup.test.js`
Expected: FAIL with `c.writeMarker is not a function`

- [ ] **Step 3: Write the implementation**

Add to `catchup.js`:

```js
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
```

Add `writeMarker` and `run` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catchup.test.js`
Expected: PASS

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS

```bash
git -C /Users/marc/telegram_gateway add catchup.js test/catchup.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(catchup): marker write and run() with digest-before-marker ordering"
```

---

### Task 4: gateway.js records forkedFrom at fork time

**Files:**
- Modify: `gateway.js` (the fork-success block in `driveTurn`, currently around lines 1375-1390)

**Interfaces:**
- Produces: every link created by a successful auto-fork carries `forkedFrom: <parentSid>`. `catchup.js` (Task 2) and `catchup-warn.js` (Task 8) key on this field; legacy links without it fall back to uuid overlap.

This is a one-line state assignment inside `driveTurn`, which spawns a real Claude child and has no unit-test seam (consistent with the rest of that function). The fast-path consumer is covered by Task 2's tests; the end-to-end write is verified in the Task 9 smoke.

- [ ] **Step 1: Make the edit**

In `driveTurn`, in the `if (forked) { ... }` branch, the current code reads:

```js
        supersededAt[sessionId] = sizeCurrent(sessionId); persistSuperseded();
        delete linkBySession[sessionId];
        await upsertLink(forkId, chatId, threadId, prompt);          // overwrites thread→session mapping
        try { linkBySession[forkId].offset = sizeCurrent(forkId); } catch (e) { /* */ }
        persistLinks();
```

Change it to (one added line; the field lets /catchup resolve the descendant without reading transcripts):

```js
        supersededAt[sessionId] = sizeCurrent(sessionId); persistSuperseded();
        delete linkBySession[sessionId];
        await upsertLink(forkId, chatId, threadId, prompt);          // overwrites thread→session mapping
        linkBySession[forkId].forkedFrom = sessionId;                // /catchup descendant fast path
        try { linkBySession[forkId].offset = sizeCurrent(forkId); } catch (e) { /* */ }
        persistLinks();
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS (no behavior change for anything tested)

- [ ] **Step 3: Commit**

```bash
git -C /Users/marc/telegram_gateway add gateway.js
git -C /Users/marc/telegram_gateway commit -m "feat(gateway): record forkedFrom on the fork link for /catchup resolution"
```

---

### Task 5: gateway.js catch-up marker readers

**Files:**
- Modify: `gateway.js`
- Test: `test/catchup-consume.test.js` (new)

**Interfaces:**
- Consumes: `STATE_DIR` (existing module const).
- Produces (exported from gateway.js; Task 6 wires them):
  - `readCatchupRequests(file, now, staleMs) -> { fresh: { sid: entry }, all: string[] }` (stale/malformed entries excluded from `fresh`, every key listed in `all`)
  - `removeCatchupEntries(file, sids) -> void` (rewrites minus `sids`, unlinks when empty; entries written between read and rewrite survive)
  - `hasPendingCatchup(sid, file, now) -> boolean`
  - `catchupDecision(entry, forkSizeNow) -> 'decline' | 'rebind'`
  - Constants: `CATCHUP_FILE` (`path.join(STATE_DIR, 'catchup.json')`), `CATCHUP_STALE_MS` (600000)

- [ ] **Step 1: Write the failing tests**

Create `test/catchup-consume.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const g = require('../gateway.js');

const NOW = 1_000_000_000;
const entry = (over = {}) => ({ forkId: 'fork-1', forkSize: 500, repoDir: '/r', ts: NOW, ...over });

function mkMarker(m) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-consume-'));
  const file = path.join(dir, 'catchup.json');
  if (m !== undefined) fs.writeFileSync(file, JSON.stringify(m));
  return file;
}

test('readCatchupRequests: fresh entries returned, stale and malformed excluded from fresh', () => {
  const file = mkMarker({
    'desk-1': entry(),
    'desk-2': entry({ ts: NOW - g.CATCHUP_STALE_MS - 1 }),
    'desk-3': { ts: NOW },                       // no forkId: malformed
  });
  const { fresh, all } = g.readCatchupRequests(file, NOW);
  assert.deepEqual(Object.keys(fresh), ['desk-1']);
  assert.deepEqual(all.sort(), ['desk-1', 'desk-2', 'desk-3']);
});

test('readCatchupRequests: missing or unparseable file is empty, never throws', () => {
  assert.deepEqual(g.readCatchupRequests(mkMarker(), NOW), { fresh: {}, all: [] });
  const file = mkMarker(); fs.writeFileSync(file, 'not json');
  assert.deepEqual(g.readCatchupRequests(file, NOW), { fresh: {}, all: [] });
});

test('removeCatchupEntries: drops named sids, keeps entries written meanwhile, unlinks when empty', () => {
  const file = mkMarker({ 'desk-1': entry(), 'desk-2': entry({ forkId: 'fork-2' }) });
  g.removeCatchupEntries(file, ['desk-1']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['desk-2']);
  g.removeCatchupEntries(file, ['desk-2']);
  assert.ok(!fs.existsSync(file), 'empty marker file is removed');
});

test('hasPendingCatchup: true only for a fresh entry', () => {
  const file = mkMarker({ 'desk-1': entry(), 'desk-2': entry({ ts: NOW - g.CATCHUP_STALE_MS - 1 }) });
  assert.equal(g.hasPendingCatchup('desk-1', file, NOW), true);
  assert.equal(g.hasPendingCatchup('desk-2', file, NOW), false);
  assert.equal(g.hasPendingCatchup('desk-9', file, NOW), false);
});

test('catchupDecision: fork growth after the digest declines, unchanged rebinds', () => {
  assert.equal(g.catchupDecision(entry({ forkSize: 500 }), 501), 'decline');
  assert.equal(g.catchupDecision(entry({ forkSize: 500 }), 500), 'rebind');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catchup-consume.test.js`
Expected: FAIL with `g.readCatchupRequests is not a function`

- [ ] **Step 3: Write the implementation**

Add to `gateway.js`, directly above the `// Poll loop:` banner comment (before `RESTART_FLAGS`):

```js
// ---------------------------------------------------------------------------
// Desk catch-up: consume /catchup request markers written by catchup.js.
// ---------------------------------------------------------------------------
const CATCHUP_FILE = path.join(STATE_DIR, 'catchup.json');
// Stale requests come from a killed session: the digest never reached a live context, so
// rebinding on it would follow a ghost. Dropped on read rather than on write, since the
// writer may be long gone.
const CATCHUP_STALE_MS = 10 * 60_000;

function readCatchupRequests(file = CATCHUP_FILE, now = Date.now(), staleMs = CATCHUP_STALE_MS) {
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { fresh: {}, all: [] }; }
  if (!m || typeof m !== 'object') return { fresh: {}, all: [] };
  const fresh = {};
  for (const [sid, e] of Object.entries(m)) {
    if (e && typeof e === 'object' && typeof e.forkId === 'string'
        && Number.isFinite(e.ts) && now - e.ts <= staleMs) fresh[sid] = e;
  }
  return { fresh, all: Object.keys(m) };
}

// Re-reads before rewriting so a marker written between our read and this cleanup survives.
function removeCatchupEntries(file, sids) {
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  for (const sid of sids) delete m[sid];
  try {
    if (Object.keys(m).length) fs.writeFileSync(file, JSON.stringify(m, null, 2));
    else fs.unlinkSync(file);
  } catch (e) { /* next tick retries */ }
}

function hasPendingCatchup(sid, file = CATCHUP_FILE, now = Date.now()) {
  return readCatchupRequests(file, now).fresh[sid] !== undefined;
}

// A fork that grew past the size the digest was cut at means a phone turn landed after the
// catch-up: the digest already ingested is still valid, but the desk is missing the remainder,
// so the rebind is declined and a re-run picks up the rest.
function catchupDecision(entry, forkSizeNow) {
  return forkSizeNow > entry.forkSize ? 'decline' : 'rebind';
}
```

Add to `module.exports` in `gateway.js`:

```js
  readCatchupRequests, removeCatchupEntries, hasPendingCatchup, catchupDecision,
  CATCHUP_FILE, CATCHUP_STALE_MS,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catchup-consume.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/marc/telegram_gateway add gateway.js test/catchup-consume.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(gateway): catch-up marker readers with stale-drop and decline rule"
```

---

### Task 6: gateway.js rebind execution and pollTick wiring

**Files:**
- Modify: `gateway.js`
- Test: `test/catchup-consume.test.js`

**Interfaces:**
- Consumes: Task 5 readers; existing `linkBySession`, `supersededAt`, `queues`, `sessionByThread`, `sizeCurrent`, `writeResumeMarker`, `persistLinks`, `persistSuperseded`, `sendPlain`, `telemetry`.
- Produces:
  - `executeCatchupRebind(deskSid, entry, ctx) -> { rebound, chatId?, threadId? }` where `ctx = { links, superseded, queues, threadIndex, sizeCurrent, writeResumeMarker, persistLinks, persistSuperseded }` (exported; fully injected so the whole mutation is unit-tested)
  - `consumeCatchupRequests(now) -> Promise<void>` (module-internal wiring; never throws into `pollTick`)
  - `pollTick` calls `consumeCatchupRequests(now)` before the file loop, and the supersede re-topic branch skips sids with a pending entry.

- [ ] **Step 1: Write the failing tests**

Append to `test/catchup-consume.test.js`:

```js
// Full injected context for executeCatchupRebind, recording every persist and resume write.
function mkCtx({ forkLinked = true, deskSize = 900, forkSize = 500, queued = null } = {}) {
  const calls = [];
  const links = forkLinked
    ? { 'fork-1': { chatId: '-100', threadId: 7, label: 'the work', offset: 480,
                    forkedFrom: 'desk-1', mirrorCursor: { offset: 480, activity: 1, prose: 0 } } }
    : {};
  const queues = new Map();
  if (queued) queues.set('fork-1', queued);
  const ctx = {
    links,
    superseded: { 'desk-1': 400 },
    queues,
    threadIndex: new Map(forkLinked ? [['-100_7', 'fork-1']] : []),
    sizeCurrent: (sid) => (sid === 'fork-1' ? forkSize : deskSize),
    writeResumeMarker: (repo, sid) => calls.push(['resume', repo, sid]),
    persistLinks: () => calls.push(['persistLinks']),
    persistSuperseded: () => calls.push(['persistSuperseded']),
  };
  return { ctx, calls };
}

test('executeCatchupRebind: superseded flips both directions and persists', () => {
  const { ctx, calls } = mkCtx();
  g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.equal(ctx.superseded['desk-1'], undefined, 'desk is live again');
  assert.equal(ctx.superseded['fork-1'], 500, 'fork superseded at its final size');
  assert.ok(calls.some((c) => c[0] === 'persistSuperseded'));
});

test('executeCatchupRebind: link moves to the desk sid, topic identity and label carried', () => {
  const { ctx, calls } = mkCtx();
  const r = g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.deepEqual(r, { rebound: true, chatId: '-100', threadId: 7 });
  assert.equal(ctx.links['fork-1'], undefined);
  const l = ctx.links['desk-1'];
  assert.equal(l.chatId, '-100');
  assert.equal(l.threadId, 7);
  assert.equal(l.label, 'the work');
  assert.equal(l.closed, false);
  assert.equal(l.offset, 900, 'offset jumps past the ingested digest');
  assert.equal(l.forkedFrom, undefined, 'a self-referential forkedFrom must not ride along');
  assert.equal(l.mirrorCursor, undefined, 'a stale cursor dies with the old offset');
  assert.equal(ctx.threadIndex.get('-100_7'), 'desk-1');
  assert.ok(calls.some((c) => c[0] === 'persistLinks'));
});

test('executeCatchupRebind: queued replies and the resume marker follow the desk sid', () => {
  const { ctx, calls } = mkCtx({ queued: ['queued reply'] });
  g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.deepEqual(ctx.queues.get('desk-1'), ['queued reply']);
  assert.equal(ctx.queues.has('fork-1'), false);
  assert.ok(calls.some((c) => c[0] === 'resume' && c[1] === '/r' && c[2] === 'desk-1'));
});

test('executeCatchupRebind: fork without a link still swaps superseded state and resume marker', () => {
  const { ctx } = mkCtx({ forkLinked: false });
  const r = g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.deepEqual(r, { rebound: false });
  assert.equal(ctx.superseded['desk-1'], undefined);
  assert.equal(ctx.superseded['fork-1'], 500);
  assert.equal(ctx.links['desk-1'], undefined, 'no link is conjured for a closed topic');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catchup-consume.test.js`
Expected: FAIL with `g.executeCatchupRebind is not a function`

- [ ] **Step 3: Write the implementation**

Add to `gateway.js`, directly below `catchupDecision`:

```js
// The atomic rebind, driveTurn's fork block inverted: desk becomes the live branch, the fork is
// superseded at its final size (if anything ever writes to it again it re-topics on its own,
// existing behavior, correct here too), the topic keeps its identity, queued replies and the
// shell resume marker follow the desk. State collaborators are injected so the whole mutation
// is unit-testable; consumeCatchupRequests binds the real ones.
function executeCatchupRebind(deskSid, entry, ctx) {
  const { forkId } = entry;
  delete ctx.superseded[deskSid];
  ctx.superseded[forkId] = ctx.sizeCurrent(forkId);
  ctx.persistSuperseded();
  const fl = ctx.links[forkId];
  if (fl) {
    delete ctx.links[forkId];
    // forkedFrom names deskSid and must not ride along, or the desk link would resolve as its
    // own descendant on the next catch-up. The mirror cursor indexes the old offset.
    const { forkedFrom, mirrorCursor, ...carried } = fl;
    ctx.links[deskSid] = { ...carried, closed: false, offset: ctx.sizeCurrent(deskSid) };
    ctx.threadIndex.set(`${fl.chatId}_${fl.threadId}`, deskSid);
    ctx.persistLinks();
  }
  if (ctx.queues.has(forkId)) { ctx.queues.set(deskSid, ctx.queues.get(forkId)); ctx.queues.delete(forkId); }
  ctx.writeResumeMarker(entry.repoDir, deskSid);
  return fl ? { rebound: true, chatId: fl.chatId, threadId: fl.threadId } : { rebound: false };
}

// Executed by the daemon because only the daemon can mutate links/superseded safely (it holds
// both in memory and persists over external edits). Never throws into pollTick, same discipline
// as renameTopicFromContent.
async function consumeCatchupRequests(now = Date.now()) {
  try {
    const { fresh, all } = readCatchupRequests(CATCHUP_FILE, now);
    if (!all.length) return;
    for (const [deskSid, entry] of Object.entries(fresh)) {
      const fl = linkBySession[entry.forkId];
      if (catchupDecision(entry, sizeCurrent(entry.forkId)) === 'decline') {
        if (fl) await sendPlain(fl.chatId, fl.threadId,
          '📱 A phone turn landed after catch-up. Run /catchup again to pull the rest.');
        console.log(`[Catchup] declined ${deskSid.slice(0, 8)}: fork grew after the digest was cut`);
        telemetry.count('gateway.catchup', { outcome: 'declined' });
        continue;
      }
      const r = executeCatchupRebind(deskSid, entry, {
        links: linkBySession, superseded: supersededAt, queues, threadIndex: sessionByThread,
        sizeCurrent, writeResumeMarker, persistLinks, persistSuperseded,
      });
      if (r.rebound) await sendPlain(r.chatId, r.threadId,
        '🖥️ Desk caught up. This topic follows the desk session again.');
      console.log(`[Catchup] rebound ${deskSid.slice(0, 8)} from fork ${entry.forkId.slice(0, 8)}`);
      telemetry.count('gateway.catchup', { outcome: 'rebound' });
    }
    removeCatchupEntries(CATCHUP_FILE, all);
  } catch (e) { console.error('[Catchup] consume error:', e.message); }
}
```

Wire into `pollTick`. The current top of the try block reads:

```js
    if (honorRestartIfReady()) return;
    const now = Date.now();
```

Change to:

```js
    if (honorRestartIfReady()) return;
    const now = Date.now();
    await consumeCatchupRequests(now);
```

Then the belt-and-suspenders: in the file loop's superseded branch, the current code reads:

```js
        if (supersededAt[id] !== undefined) {                        // desk branch we forked away from
          if (st.size > supersededAt[id]) { delete supersededAt[id]; persistSuperseded(); }  // desk kept working → re-topic
          else continue;                                             // still at the fork point → stay hidden
        }
```

Change to:

```js
        if (supersededAt[id] !== undefined) {                        // desk branch we forked away from
          if (st.size > supersededAt[id]) {
            // With a catch-up pending, this growth IS the digest ingest: consumption rebinds the
            // EXISTING topic on the next tick, so re-topicing here would fork the topic identity.
            if (hasPendingCatchup(id)) continue;
            delete supersededAt[id]; persistSuperseded();            // desk kept working → re-topic
          }
          else continue;                                             // still at the fork point → stay hidden
        }
```

Add `executeCatchupRebind` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catchup-consume.test.js`
Expected: PASS

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS

```bash
git -C /Users/marc/telegram_gateway add gateway.js test/catchup-consume.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(gateway): consume catch-up markers, atomic rebind of topic to the desk branch"
```

---

### Task 7: /catchup command file, installer, packaging

**Files:**
- Create: `commands/catchup.md`
- Modify: `install-service.sh` (after the zshrc block, before the final `echo "✅ ..."`)
- Modify: `package.json` (`files` array)
- Test: `test/packaging.test.js` (existing tests must pass with the new files; add the new entrypoints)

**Interfaces:**
- Consumes: `catchup.js` CLI (Task 3): prints a digest or a line starting with `nothing pending`.
- Produces: `~/.claude/commands/catchup.md` with `{{GATEWAY_DIR}}` resolved to the install dir, so `/catchup` works identically in Claude Code CLI and Claude Desktop Code (both read `~/.claude/commands/`).

- [ ] **Step 1: Write the failing test**

In `test/packaging.test.js`, extend the entrypoints list so the tarball guard covers the new runtime files (catchup-warn.js arrives in Task 8; adding it here now keeps this file touched once, so this test stays red until Task 8 unless you add it then. Add only catchup.js now):

```js
  const entrypoints = ['gateway.js', 'setup.js', 'resume-hook.js', 'bin/claude-tg.js', 'catchup.js'];
```

Add a second assertion inside that same test (after the loop), so the command source ships:

```js
  assert.ok(packed.has('commands/catchup.md'), 'commands/catchup.md is not in the tarball');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/packaging.test.js`
Expected: FAIL with `entrypoint catchup.js is not in the tarball`

- [ ] **Step 3: Write the command file and wire packaging**

Create `commands/catchup.md` (the `{{GATEWAY_DIR}}` placeholder is resolved at install time; a global npm install and a git checkout live at different paths):

```markdown
---
description: Pull phone-branch turns into this open desk session and rebind its Telegram topic
---

Run exactly this command with the Bash tool (single command, no pipes, no cd):

    node "{{GATEWAY_DIR}}/catchup.js"

Then:

1. If the output starts with "nothing pending" or "catchup:", relay that line to the user and stop.
2. Otherwise the output is a verbatim digest of the phone branch: lines marked "📱 phone:" are
   prompts the user sent from their phone, 🔧 lines are one-line tool traces, and the rest is the
   assistant's replies. Treat those turns as things that already happened in this conversation.
3. Reply with a one-paragraph recap of what happened on the phone and where the work now stands.
4. Do not edit links.json, superseded.json, or catchup.json. The gateway daemon performs the
   Telegram topic rebind itself within a few seconds of the command finishing.
```

In `package.json` `files`, after `"resume-hook.js",` add:

```json
    "catchup.js",
    "catchup-warn.js",
    "commands/",
```

(`catchup-warn.js` is listed now so the Task 8 file lands in an already-correct allowlist; `npm pack` ignores a listed-but-absent file, so packaging tests stay green in between.)

In `install-service.sh`, after the zshrc block (after line `fi` closing the auto-resume hook, before `echo "✅ Installed and started $LABEL."`), add:

```bash
# /catchup slash command: pulls phone-branch turns into an open desk session. The command file
# needs the real install path baked in, since a global npm install and a checkout differ.
CMD_DIR="$HOME/.claude/commands"
mkdir -p "$CMD_DIR"
sed "s|{{GATEWAY_DIR}}|$DIR|g" "$DIR/commands/catchup.md" > "$CMD_DIR/catchup.md"
echo "🔗 Installed /catchup command to $CMD_DIR/catchup.md"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/packaging.test.js`
Expected: PASS

Run: `bash -n install-service.sh`
Expected: no output (syntax clean)

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS

```bash
git -C /Users/marc/telegram_gateway add commands/catchup.md install-service.sh package.json test/packaging.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(catchup): /catchup slash command, installed with the service"
```

---

### Task 8: Phase 2, catchup-warn.js hook and opt-in install

**Files:**
- Create: `catchup-warn.js`
- Modify: `setup.js` (opt-in prompt at the end of the flow)
- Modify: `test/packaging.test.js` (add `catchup-warn.js` to entrypoints)
- Test: `test/catchup-warn.test.js` (new)

**Interfaces:**
- Consumes: `findTranscript(sid, projectsDir)` and `STATE_DIR` from `./catchup.js`.
- Produces:
  - `countPhoneTurns(forkFile, fromOffset) -> number` (real user turns past the byte offset: `type === 'user'`, not `isMeta`, text not starting with `<`)
  - `warnLine(sessionId, superseded, links, findForkFile) -> string|null`
  - `installWarnHook(settingsFile, gatewayDir) -> string` (idempotent merge into `~/.claude/settings.json` for UserPromptSubmit and SessionStart; exported from catchup-warn.js because setup.js is an unguarded IIFE and cannot be required by tests)
  - CLI: reads hook JSON on stdin, prints the warn line or nothing. Fast path: `session_id` absent from `superseded.json` exits after two small JSON reads.
  - Self-clearing by construction: the Task 6 rebind deletes the sid from `superseded.json`, so the fast path goes silent after a catch-up.

- [ ] **Step 1: Write the failing tests**

Create `test/catchup-warn.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const w = require('../catchup-warn.js');

const J = (o) => JSON.stringify(o) + '\n';

function mkFork() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-warn-'));
  const file = path.join(dir, 'fork-1.jsonl');
  const history = J({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'old desk prompt' } });
  const region = [
    { uuid: 'u2', type: 'user', message: { role: 'user', content: 'phone turn one' } },
    { uuid: 'u3', type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
    { uuid: 'u4', type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { uuid: 'u5', type: 'user', message: { role: 'user', content: '<command-name>/x</command-name>' } },
    { uuid: 'u6', type: 'user', message: { role: 'user', content: 'phone turn two' } },
  ].map(J).join('');
  fs.writeFileSync(file, history + region);
  return { dir, file, offset: Buffer.byteLength(history, 'utf8') };
}

test('countPhoneTurns: real user turns past the offset only', () => {
  const { file, offset } = mkFork();
  assert.equal(w.countPhoneTurns(file, offset), 2);
  assert.equal(w.countPhoneTurns(file, 0), 3, 'offset 0 also counts the history turn');
  assert.equal(w.countPhoneTurns(file, 10_000_000), 0, 'offset past EOF is zero, not a throw');
});

test('warnLine: names the turn count and the command', () => {
  const { file, offset } = mkFork();
  const line = w.warnLine('desk-1',
    { 'desk-1': offset },
    { 'fork-1': { forkedFrom: 'desk-1' } },
    () => file);
  assert.equal(line, '📱 Phone branch is 2 turns ahead. Run /catchup to pull them in.');
});

test('warnLine: silent when not superseded, no forkedFrom link, or nothing new', () => {
  const { file, offset } = mkFork();
  assert.equal(w.warnLine('desk-1', {}, { 'fork-1': { forkedFrom: 'desk-1' } }, () => file), null,
    'self-clears once the rebind removes the sid from superseded');
  assert.equal(w.warnLine('desk-1', { 'desk-1': offset }, {}, () => file), null,
    'legacy links without forkedFrom stay silent, warn is best-effort');
  assert.equal(w.warnLine('desk-1', { 'desk-1': offset }, { 'fork-1': { forkedFrom: 'desk-1' } }, () => null), null);
  const size = fs.statSync(file).size;
  assert.equal(w.warnLine('desk-1', { 'desk-1': size }, { 'fork-1': { forkedFrom: 'desk-1' } }, () => file), null,
    'no turns past the fork point');
});

test('installWarnHook: registers both events, idempotent, preserves existing settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-settings-'));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'echo other' }] },
  ] } }));
  w.installWarnHook(settings, '/opt/gw');
  w.installWarnHook(settings, '/opt/gw');   // second run must not duplicate
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.model, 'opus', 'unrelated settings preserved');
  const cmds = (ev) => s.hooks[ev].flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(cmds('UserPromptSubmit'),
    ['echo other', 'node "/opt/gw/catchup-warn.js"']);
  assert.deepEqual(cmds('SessionStart'), ['node "/opt/gw/catchup-warn.js"']);
});

test('installWarnHook: creates the settings file when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-settings-'));
  const settings = path.join(dir, 'sub', 'settings.json');
  w.installWarnHook(settings, '/opt/gw');
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(s.hooks.SessionStart.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/catchup-warn.test.js`
Expected: FAIL with `Cannot find module '../catchup-warn.js'`

- [ ] **Step 3: Write the implementation**

Create `catchup-warn.js`:

```js
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
```

Note: Task 1's `catchup.js` must export `readJson` (it is in the Task 1 export list; verify).

In `setup.js`, before `rl.close();` at the end of the IIFE (after the install-service prompt block), add:

```js
  if (yes(await ask('\nInstall the phone-branch warning hook? It adds a one-line notice in desk ' +
      'sessions when phone turns are waiting (writes to ~/.claude/settings.json). [y/N] '))) {
    const { installWarnHook } = require('./catchup-warn.js');
    const f = installWarnHook(path.join(os.homedir(), '.claude', 'settings.json'), __dirname);
    console.log(`   ✅ Hook registered in ${f} (UserPromptSubmit + SessionStart).`);
  }
```

In `test/packaging.test.js`, extend the entrypoints:

```js
  const entrypoints = ['gateway.js', 'setup.js', 'resume-hook.js', 'bin/claude-tg.js', 'catchup.js', 'catchup-warn.js'];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/catchup-warn.test.js test/packaging.test.js`
Expected: PASS

- [ ] **Step 5: Full suite, then commit**

Run: `npm test`
Expected: PASS

```bash
git -C /Users/marc/telegram_gateway add catchup-warn.js setup.js test/catchup-warn.test.js test/packaging.test.js
git -C /Users/marc/telegram_gateway commit -m "feat(catchup): phase-2 warn hook with opt-in install via setup"
```

---

### Task 9: docs, version bump, live smoke

**Files:**
- Modify: `README.md` (the phone-branch section around lines 180-190, where the auto-resume hook is described)
- Modify: `package.json` (version `1.4.6` -> `1.5.0`)

- [ ] **Step 1: README**

In the section describing returning to the desk (near the auto-resume hook text at README.md line ~182), add a bullet:

```markdown
  - **Already-open session:** run `/catchup` inside it. It ingests the phone turns verbatim
    (prompts, replies, one-line tool traces), the topic follows the desk session again, and the
    phone branch is retired. If a phone turn lands mid-catch-up, the gateway asks you to run it
    once more. Optional: `npm run setup` can install a hook that prints "📱 Phone branch is N
    turns ahead" in a desk session that has fallen behind.
```

- [ ] **Step 2: Version bump**

In `package.json`: `"version": "1.5.0"` (new user-facing feature, minor bump).

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Live smoke (deployment proof, per the running-marker discipline)**

This machine runs the gateway. After merge to the main branch:

1. `touch ~/.claude-gateway/restart.flag` and wait for relaunch (never `launchctl kickstart` from a gateway-driven turn).
2. Confirm the new code is live: `cat ~/.claude-gateway/running.json` shows the new sha/version.
3. `./install-service.sh` once to install `~/.claude/commands/catchup.md`.
4. Real flow: open a desk session, reply to its topic from the phone (forces a fork), then run `/catchup` at the desk. Verify: digest appears in the desk session; within a few seconds the topic posts "🖥️ Desk caught up."; `links.json` maps the topic to the desk sid with `forkedFrom` absent; `superseded.json` holds the fork at its final size; `catchup.json` is gone; a fresh link created by a new phone fork carries `forkedFrom` (verifies Task 4's untested line).

- [ ] **Step 5: Commit**

```bash
git -C /Users/marc/telegram_gateway add README.md package.json
git -C /Users/marc/telegram_gateway commit -m "docs: /catchup usage; release: v1.5.0"
```

Release after merge follows the repo's standard flow (bump is done; tag and publish via the OIDC workflow, per house rule that a merge is not a release).
