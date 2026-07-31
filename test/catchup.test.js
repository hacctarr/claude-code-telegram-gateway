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
  assert.equal(digest.text,
    '📱 phone: phone: check  the\ndeploy\n\n🔧 Bash: git status\n\nAll clean.');
  assert.ok(!digest.text.includes('desk reply'), 'copied history must not appear');
  assert.deepEqual(digest.uuids, ['u3', 'u4'], 'only entries that rendered are reported as shown');
});

test('buildDigest: uuids already shown by a declined run are subtracted', () => {
  const { proj } = mkFixture();
  const deskUuids = c.uuidSet(c.readTranscriptLines(path.join(proj, 'desk-sid.jsonl')));
  const forkLines = c.readTranscriptLines(path.join(proj, 'fork-sid.jsonl'));
  const digest = c.buildDigest(forkLines, deskUuids, new Set(['u3']));
  assert.ok(!digest.text.includes('phone: check'), 'the shown turn is not repeated');
  assert.ok(digest.text.includes('All clean.'), 'the unshown turn still lands');
  assert.deepEqual(digest.uuids, ['u4']);
});

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

test('run: forkSize describes what was digested, not an earlier stat', async () => {
  // A phone turn landing between the size stat and the content read would make forkSize
  // stale-small relative to the digest, and the daemon would decline a rebind whose digest
  // was already complete. Size must be derived from the bytes actually digested.
  const { root, projectsDir, proj } = mkFixture();
  const forkFile = path.join(proj, 'fork-sid.jsonl');
  const stateDir = mkStateDir(root, {
    superseded: { 'desk-sid': 100 },
    links: { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } },
  });
  const lateTurn = J({ uuid: 'u9', type: 'user', message: { role: 'user', content: 'late phone turn' } });
  const grewBy = Buffer.byteLength(lateTurn);
  const realRead = fs.readFileSync;
  let grew = false;
  // Grow the fork exactly once, at the moment run() first reads it: the interleaving that a
  // stat-then-read ordering cannot see.
  fs.readFileSync = function (file, ...rest) {
    const out = realRead.call(fs, file, ...rest);
    if (!grew && file === forkFile) {
      grew = true;
      fs.appendFileSync(forkFile, lateTurn);
    }
    return out;
  };
  let code;
  try {
    code = await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut([]) });
  } finally { fs.readFileSync = realRead; }
  assert.equal(code, 0);
  const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'catchup.json'), 'utf8'));
  // The digest covers the pre-append bytes only, and forkSize says exactly that: the late turn
  // is genuinely outside the digest, so the daemon declines on it for a real reason rather than
  // on a stale stat. u9 must not have been rendered.
  assert.ok(!m['desk-sid'].shownUuids.includes('u9'), 'the late turn is not in the digest');
  assert.equal(m['desk-sid'].forkSize, fs.statSync(forkFile).size - grewBy,
    'recorded size is the digested byte count, not a pre-read stat');
  assert.ok(m['desk-sid'].forkSize < fs.statSync(forkFile).size,
    'so the daemon still declines, correctly, on the genuinely-missing turn');
});

test('run: a re-run after a decline shows only the remainder, not the whole digest again', async () => {
  // The declined marker records what was already shown; the retry subtracts it. Without this
  // the user re-reads every turn they just read.
  const { root, projectsDir, proj } = mkFixture();
  const forkFile = path.join(proj, 'fork-sid.jsonl');
  const stateDir = mkStateDir(root, {
    superseded: { 'desk-sid': 100 },
    links: { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } },
  });
  const first = [];
  await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut(first) });
  const firstText = first.map((e) => e.text).join('');
  assert.ok(firstText.includes('phone: check'), 'first run shows the original turns');

  // A phone turn lands mid-catch-up; the daemon declines and retains the entry with the
  // uuids already shown (what consumeCatchupRequests does on the decline path).
  fs.appendFileSync(forkFile,
    J({ uuid: 'u9', type: 'user', message: { role: 'user', content: 'late phone turn' } }));
  const marker = path.join(stateDir, 'catchup.json');
  const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  m['desk-sid'] = { ...m['desk-sid'], declined: true, shownUuids: ['u3', 'u4'] };
  fs.writeFileSync(marker, JSON.stringify(m));

  const second = [];
  await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut(second) });
  const secondText = second.map((e) => e.text).join('');
  assert.ok(secondText.includes('late phone turn'), 're-run shows the new turn');
  assert.ok(!secondText.includes('phone: check'), 'already-shown turns are not repeated');
  assert.ok(!secondText.includes('All clean.'), 'already-shown assistant text is not repeated');
});

test('run: marker records the digested uuids so a later decline can subtract them', async () => {
  const { root, projectsDir } = mkFixture();
  const stateDir = mkStateDir(root, {
    superseded: { 'desk-sid': 100 },
    links: { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } },
  });
  await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut([]) });
  const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'catchup.json'), 'utf8'));
  assert.deepEqual(m['desk-sid'].shownUuids.sort(), ['u3', 'u4'],
    'only uuids that rendered into the digest are recorded');
});

test('run: the retry clears the declined flag, so the daemon sees a live request again', async () => {
  const { root, projectsDir, proj } = mkFixture();
  const stateDir = mkStateDir(root, {
    superseded: { 'desk-sid': 100 },
    links: { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } },
  });
  const marker = path.join(stateDir, 'catchup.json');
  fs.writeFileSync(marker, JSON.stringify({
    'desk-sid': { forkId: 'fork-sid', forkSize: 1, repoDir: '/r', ts: 1,
                  declined: true, shownUuids: ['u3', 'u4'] },
  }));
  fs.appendFileSync(path.join(proj, 'fork-sid.jsonl'),
    J({ uuid: 'u9', type: 'user', message: { role: 'user', content: 'late phone turn' } }));
  await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut([]) });
  const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(m['desk-sid'].declined, undefined, 'a fresh request is not still marked declined');
  assert.deepEqual(m['desk-sid'].shownUuids.sort(), ['u3', 'u4', 'u9'],
    'the shown set accumulates across the decline so a second decline still subtracts correctly');
});

test('run: everything already shown by a declined run prints nothing pending', async () => {
  const { root, projectsDir } = mkFixture();
  const stateDir = mkStateDir(root, {
    superseded: { 'desk-sid': 100 },
    links: { 'fork-sid': { chatId: '-1', threadId: 5, forkedFrom: 'desk-sid' } },
  });
  const marker = path.join(stateDir, 'catchup.json');
  fs.writeFileSync(marker, JSON.stringify({
    'desk-sid': { forkId: 'fork-sid', forkSize: 10, repoDir: '/r', ts: 1,
                  declined: true, shownUuids: ['u3', 'u4'] },
  }));
  const events = [];
  const code = await c.run({ sid: 'desk-sid', stateDir, projectsDir, out: fakeOut(events) });
  assert.equal(code, 0);
  assert.match(events[0].text, /^nothing pending/);
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
