'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Requiring gateway.js is safe: boot is guarded behind require.main === module.
const g = require('../gateway.js');

// ---------------------------------------------------------------------------
// summarizeToolInput
// ---------------------------------------------------------------------------
test('summarizeToolInput: Bash shows the command, whitespace-collapsed', () => {
  assert.equal(g.summarizeToolInput('Bash', { command: 'ls   -la\n/tmp' }), 'ls -la /tmp');
});
test('summarizeToolInput: file tools show the path', () => {
  assert.equal(g.summarizeToolInput('Read', { file_path: '/a/b.js' }), '/a/b.js');
  assert.equal(g.summarizeToolInput('Grep', { pattern: 'foo' }), 'foo');
});
test('summarizeToolInput: unknown input falls back to compact JSON', () => {
  assert.equal(g.summarizeToolInput('Weird', { foo: 'bar' }), '{"foo":"bar"}');
});
test('summarizeToolInput: null/empty input returns empty string', () => {
  assert.equal(g.summarizeToolInput('X', null), '');
});
test('summarizeToolInput: long command is truncated to 120 chars', () => {
  const long = 'x'.repeat(500);
  assert.equal(g.summarizeToolInput('Bash', { command: long }).length, 120);
});

// ---------------------------------------------------------------------------
// createFeed — the stream-json event reducer
// ---------------------------------------------------------------------------
const EVENTS = [
  { type: 'system', subtype: 'init', session_id: 'init-id' },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } } },
  { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'Hello world' },
];

test('createFeed: builds tool step + streamed text in order', () => {
  const feed = g.createFeed(true);
  for (const e of EVENTS) feed.handle(e);
  assert.equal(feed.render(), '🔧 Bash: echo hi\nHello world');
});
test('createFeed: captures result session id and error flag', () => {
  const feed = g.createFeed(true);
  for (const e of EVENTS) feed.handle(e);
  assert.equal(feed.sessionId, 'sess-1');
  assert.equal(feed.isError, false);
  assert.equal(feed.sawContent, true);
});
test('createFeed: handle() signals visible changes only', () => {
  const feed = g.createFeed(true);
  assert.equal(feed.handle(EVENTS[0]), false, 'system init = no visible change');
  assert.equal(feed.handle(EVENTS[1]), false, 'thinking block = no visible change');
  assert.equal(feed.handle(EVENTS[2]), true, 'tool_use = visible');
  assert.equal(feed.handle(EVENTS[3]), true, 'text delta = visible');
  assert.equal(feed.handle(EVENTS[5]), false, 'result = no visible change');
});
test('createFeed: showTools=false hides tool steps', () => {
  const feed = g.createFeed(false);
  for (const e of EVENTS) feed.handle(e);
  assert.equal(feed.render(), 'Hello world');
});
test('createFeed: is_error / non-success subtype sets isError', () => {
  const feed = g.createFeed(true);
  feed.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', result: 'boom' });
  assert.equal(feed.isError, true);
  assert.equal(feed.resultText, 'boom');
});
test('createFeed: finish() falls back to result text when nothing streamed', () => {
  const feed = g.createFeed(true);
  feed.handle({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'final only' });
  assert.equal(feed.sawContent, false);
  assert.equal(feed.finish(), 'final only');
});
test('createFeed: empty feed renders the working placeholder', () => {
  assert.equal(g.createFeed(true).render(), '⚙️ Working…');
});

// ---------------------------------------------------------------------------
// LiveMessage — throttled in-place editing + page rollover
// ---------------------------------------------------------------------------
function mockLive(live) {
  live._calls = [];
  let n = 0;
  live._sendNew = async (t) => { const id = ++n; live._calls.push({ op: 'send', id, len: t.length }); return id; };
  live._editCur = async (t) => {
    if (live.curId == null || t === live.sentForCur) return; // real dedupe behavior
    live.sentForCur = t;
    live.lastEditAt = Date.now();
    live._calls.push({ op: 'edit', id: live.curId, len: t.length, text: t });
  };
  return live;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('LiveMessage: coalesces rapid updates into one send + a final edit', async () => {
  const L = mockLive(new g.LiveMessage('c', 't'));
  await L.set('step\n');           // first content -> send
  await L.set('step\nA');          // immediate first edit
  await L.set('step\nAB');         // throttled
  await L.set('step\nABC');        // throttled (coalesced)
  await L.finalize('step\nABC done');
  await sleep(30);
  const sends = L._calls.filter((c) => c.op === 'send');
  assert.equal(sends.length, 1, 'exactly one message created');
  assert.ok(L.sentForCur.endsWith('done'), 'final edit lands the complete text');
});

test('LiveMessage: dedupes identical content (no redundant edit)', async () => {
  const L = mockLive(new g.LiveMessage('c', 't'));
  await L.set('hello');
  await L.finalize('hello');       // same text
  await sleep(10);
  const edits = L._calls.filter((c) => c.op === 'edit');
  assert.equal(edits.length, 0, 'no edit when text is unchanged');
});

test('LiveMessage: rolls a >3800-char transcript across multiple messages', async () => {
  const L = mockLive(new g.LiveMessage('c', 't'));
  const big = Array.from({ length: 9000 }, (_, i) => (i % 80 === 79 ? '\n' : 'x')).join('');
  await L.finalize(big);
  await sleep(20);
  const sends = L._calls.filter((c) => c.op === 'send');
  assert.equal(sends.length, 3, 'splits into 3 pages');
  assert.ok(sends.every((c) => c.len <= 3800), 'every page within Telegram cap');
});

// ---------------------------------------------------------------------------
// Session discovery — readSessionInfo / listSessions / matchSessions
// ---------------------------------------------------------------------------
function makeFixtures() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const proj = path.join(home, '.claude', 'projects', 'proj1');
  fs.mkdirSync(proj, { recursive: true });
  const write = (id, cwd, lines, ageSec) => {
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const t = Date.now() / 1000 - ageSec;
    fs.utimesSync(p, t, t);
  };
  // Newest -> oldest via ageSec.
  write('sess-login', '/test/repo', [
    { type: 'user', cwd: '/test/repo', message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'sure' }] } },
  ], 100);
  write('sess-shinzo', '/test/repo', [
    { type: 'user', cwd: '/test/repo', message: { role: 'user', content: 'Hi' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Configuring the Shinzo keyword server.' }] } },
  ], 50);
  write('sess-hello', '/test/repo', [
    { type: 'user', cwd: '/test/repo', message: { role: 'user', content: 'Hello world project' } },
  ], 200);
  write('sess-other', '/other/repo', [
    { type: 'user', cwd: '/other/repo', message: { role: 'user', content: 'unrelated work' } },
  ], 10);
  return home;
}

async function withFixtureHome(fn) {
  const realHome = process.env.HOME;
  const home = makeFixtures();
  process.env.HOME = home;
  try { return await fn(); }
  finally { process.env.HOME = realHome; fs.rmSync(home, { recursive: true, force: true }); }
}

test('readSessionInfo: extracts cwd + first user message as label', async () => {
  await withFixtureHome(async () => {
    const file = path.join(process.env.HOME, '.claude', 'projects', 'proj1', 'sess-login.jsonl');
    const info = await g.readSessionInfo(file);
    assert.equal(info.id, 'sess-login');
    assert.equal(info.cwd, '/test/repo');
    assert.equal(info.label, 'Fix the login bug');
  });
});

test('listSessions: filters by cwd and sorts newest-first', async () => {
  await withFixtureHome(async () => {
    const list = await g.listSessions('/test/repo');
    assert.deepEqual(list.map((s) => s.id), ['sess-shinzo', 'sess-login', 'sess-hello'],
      'excludes /other/repo, newest first');
  });
});

test('matchSessions: matches on the label (first message)', async () => {
  await withFixtureHome(async () => {
    const m = await g.matchSessions('/test/repo', 'login');
    assert.equal(m.length, 1);
    assert.equal(m[0].id, 'sess-login');
  });
});

test('matchSessions: falls back to full-text content search', async () => {
  await withFixtureHome(async () => {
    const m = await g.matchSessions('/test/repo', 'Shinzo'); // only in content, not label
    assert.equal(m.length, 1);
    assert.equal(m[0].id, 'sess-shinzo');
  });
});

test('matchSessions: returns empty when nothing matches', async () => {
  await withFixtureHome(async () => {
    assert.deepEqual(await g.matchSessions('/test/repo', 'zzz-nomatch'), []);
  });
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
test('relTime: humanizes recent timestamps', () => {
  assert.equal(g.relTime(Date.now()), 'just now');
  assert.match(g.relTime(Date.now() - 5 * 60 * 1000), /^5m ago$/);
  assert.match(g.relTime(Date.now() - 3 * 3600 * 1000), /^3h ago$/);
  assert.match(g.relTime(Date.now() - 2 * 86400 * 1000), /^2d ago$/);
});

test('formatSessionList: renders label, age and id, capped', () => {
  const sessions = [
    { id: 'aaa', label: 'First task', mtime: Date.now() - 60000 },
    { id: 'bbb', label: '', mtime: Date.now() - 3600000 },
  ];
  const out = g.formatSessionList(sessions);
  assert.match(out, /First task/);
  assert.match(out, /id: aaa/);
  assert.match(out, /\(no first message\)/); // empty label fallback
});

// ---------------------------------------------------------------------------
// renderTranscriptLine — stored transcript record -> Telegram post strings
// ---------------------------------------------------------------------------
test('renderTranscriptLine: assistant text is posted verbatim', () => {
  const o = { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } };
  assert.deepEqual(g.renderTranscriptLine(o), ['Hello there']);
});
test('renderTranscriptLine: assistant tool_use -> 🔧 line', () => {
  const o = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } };
  assert.deepEqual(g.renderTranscriptLine(o), ['🔧 Bash: echo hi']);
});
test('renderTranscriptLine: showTools=false hides tool_use', () => {
  const o = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } };
  assert.deepEqual(g.renderTranscriptLine(o, false), []);
});
test('renderTranscriptLine: real desk user text -> 🖥️ desk prefix', () => {
  const o = { type: 'user', isMeta: false, message: { content: 'Fix the bug' } };
  assert.deepEqual(g.renderTranscriptLine(o), ['🖥️ desk: Fix the bug']);
});
test('renderTranscriptLine: skips thinking / meta / command-caveats / tool_result', () => {
  assert.deepEqual(g.renderTranscriptLine({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }), []);
  assert.deepEqual(g.renderTranscriptLine({ type: 'user', isMeta: true, message: { content: 'meta' } }), []);
  assert.deepEqual(g.renderTranscriptLine({ type: 'user', message: { content: '<local-command>hi</local-command>' } }), []);
  assert.deepEqual(g.renderTranscriptLine({ type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } }), []);
  assert.deepEqual(g.renderTranscriptLine({ type: 'system' }), []);
});
test('renderTranscriptLine: mixed text + tool blocks preserve order', () => {
  const o = { type: 'assistant', message: { content: [
    { type: 'text', text: 'Running now' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } },
  ] } };
  assert.deepEqual(g.renderTranscriptLine(o), ['Running now', '🔧 Read: /a.js']);
});

// ---------------------------------------------------------------------------
// readNewLines — incremental offset reader
// ---------------------------------------------------------------------------
test('readNewLines: reads complete records and advances offset; keeps partial tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-nl-'));
  const f = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(f, JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ a: 2 }) + '\n');
    const r1 = g.readNewLines(f, 0);
    assert.equal(r1.lines.length, 2);
    assert.equal(r1.lines[1].a, 2);
    assert.equal(r1.newOffset, fs.statSync(f).size);

    // Append a partial (no trailing newline) then a completing newline.
    fs.appendFileSync(f, JSON.stringify({ a: 3 }));      // incomplete
    const r2 = g.readNewLines(f, r1.newOffset);
    assert.equal(r2.lines.length, 0, 'incomplete line not yet emitted');
    assert.equal(r2.newOffset, r1.newOffset, 'offset unchanged until line completes');

    fs.appendFileSync(f, '\n');                           // complete it
    const r3 = g.readNewLines(f, r2.newOffset);
    assert.equal(r3.lines.length, 1);
    assert.equal(r3.lines[0].a, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('readNewLines: multi-byte content keeps byte offsets correct', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-nl2-'));
  const f = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(f, JSON.stringify({ t: '🔧 émojis' }) + '\n');
    const r = g.readNewLines(f, 0);
    assert.equal(r.lines[0].t, '🔧 émojis');
    assert.equal(r.newOffset, fs.statSync(f).size);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Activity windows
// ---------------------------------------------------------------------------
test('isActive / shouldPrune / isDeskBusy boundaries (defaults 30m / 7d / 15s)', () => {
  const now = Date.now();
  assert.equal(g.isActive(now - 60_000, now), true);           // 1m ago -> active
  assert.equal(g.isActive(now - 40 * 60_000, now), false);      // 40m ago -> not
  assert.equal(g.shouldPrune(now - 3 * 86400_000, now), false); // 3d -> keep
  assert.equal(g.shouldPrune(now - 8 * 86400_000, now), true);  // 8d -> prune
  assert.equal(g.isDeskBusy(now - 5_000, now), true);           // 5s -> busy
  assert.equal(g.isDeskBusy(now - 60_000, now), false);         // 60s -> idle
});

// ---------------------------------------------------------------------------
// Link store internals
// ---------------------------------------------------------------------------
test('invertRepoMappings: repoDir -> chatId', () => {
  const inv = g.invertRepoMappings({ '-100abc': '/repo/a', '-100def': '/repo/b' });
  assert.equal(inv['/repo/a'], '-100abc');
  assert.equal(inv['/repo/b'], '-100def');
});
test('splitThreadKey: handles negative chat ids with underscores', () => {
  assert.deepEqual(g.splitThreadKey('-1003953985506_104'), ['-1003953985506', '104']);
});
test('buildThreadIndex: maps chat_thread -> sessionId', () => {
  const idx = g.buildThreadIndex({ sidA: { chatId: '-100', threadId: 5 } });
  assert.equal(idx.get('-100_5'), 'sidA');
});
test('migrateLegacy: converts old sessions.json entries into links', () => {
  const links = {};
  g.migrateLegacy(links, { '-1003953985506_104': 'sid-1' });
  assert.equal(links['sid-1'].chatId, '-1003953985506');
  assert.equal(links['sid-1'].threadId, 104);
  assert.equal(links['sid-1'].offset, 0);
});
test('migrateLegacy: does not overwrite an existing link', () => {
  const links = { 'sid-1': { chatId: 'x', threadId: 1, offset: 999 } };
  g.migrateLegacy(links, { 'a_2': 'sid-1' });
  assert.equal(links['sid-1'].offset, 999);
});

// ---------------------------------------------------------------------------
// Topic naming / opener formatting
// ---------------------------------------------------------------------------
test('topicName: uses label, falls back to short id', () => {
  assert.equal(g.topicName({ id: 'abcdef12-0000', label: 'Fix login' }), '🤖 Fix login');
  assert.match(g.topicName({ id: 'abcdef12-0000', label: '' }), /^🤖 Claude abcdef12$/);
});
test('openerText: mentions the session id and the cr resume hint', () => {
  const t = g.openerText({ id: 'abcdef12-3456', label: 'Fix login', mtime: Date.now() });
  assert.match(t, /abcdef12/);
  assert.match(t, /cr/);
  assert.match(t, /Fix login/);
});

// ---------------------------------------------------------------------------
// shouldAutoCreate — sidechain / empty-session filter (#3)
// ---------------------------------------------------------------------------
test('shouldAutoCreate: true only when a real user message (label) exists', () => {
  assert.equal(g.shouldAutoCreate({ id: 'x', label: 'Fix login bug' }), true);
  assert.equal(g.shouldAutoCreate({ id: 'x', label: '' }), false);   // sub-agent/command-only
  assert.equal(g.shouldAutoCreate({ id: 'x', label: null }), false);
  assert.equal(g.shouldAutoCreate(null), false);
});

// ---------------------------------------------------------------------------
// ignoredSessions persistence (#5)
// ---------------------------------------------------------------------------
test('loadIgnored / persistIgnored: round-trip through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ign-'));
  const file = path.join(dir, 'ignored.json');
  try {
    g.persistIgnored(file, new Set(['sid-a', 'sid-b']));
    const restored = g.loadIgnored(file, new Set());
    assert.ok(restored.has('sid-a') && restored.has('sid-b'));
    assert.equal(restored.size, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('loadIgnored: missing file yields empty set (no throw)', () => {
  const set = g.loadIgnored(path.join(os.tmpdir(), 'does-not-exist-xyz.json'), new Set());
  assert.equal(set.size, 0);
});

// ---------------------------------------------------------------------------
// persisted — held/ephemeral detector (gap #1 handling)
// ---------------------------------------------------------------------------
test('persisted: transcript growth means the turn stuck; no growth means desk held it open', () => {
  assert.equal(g.persisted(1000, 1200), true);   // grew -> saved
  assert.equal(g.persisted(1000, 1000), false);  // no growth -> desk open, ephemeral
  assert.equal(g.persisted(1000, 999), false);
});
