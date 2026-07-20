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
  assert.deepEqual(g.splitThreadKey('-1001234567890_104'), ['-1001234567890', '104']);
});
test('buildThreadIndex: maps chat_thread -> sessionId', () => {
  const idx = g.buildThreadIndex({ sidA: { chatId: '-100', threadId: 5 } });
  assert.equal(idx.get('-100_5'), 'sidA');
});
test('migrateLegacy: converts old sessions.json entries into links', () => {
  const links = {};
  g.migrateLegacy(links, { '-1001234567890_104': 'sid-1' });
  assert.equal(links['sid-1'].chatId, '-1001234567890');
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
test('topicName: slugifies the label, falls back to short id', () => {
  assert.equal(g.topicName({ id: 'abcdef12-0000', label: 'Fix login' }), '🤖 fix-login');
  assert.match(g.topicName({ id: 'abcdef12-0000', label: '' }), /^🤖 claude-abcdef$/);
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

// ---------------------------------------------------------------------------
// renderTranscriptLine — tool errors surface, successes stay quiet
// ---------------------------------------------------------------------------
test('renderTranscriptLine: surfaces tool errors from desk runs', () => {
  const o = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: missing.txt' }] } };
  assert.deepEqual(g.renderTranscriptLine(o), ['⚠️ tool error: ENOENT: missing.txt']);
});
test('renderTranscriptLine: successful tool results stay quiet', () => {
  const o = { type: 'user', message: { content: [{ type: 'tool_result', is_error: false, content: 'lots of output' }] } };
  assert.deepEqual(g.renderTranscriptLine(o), []);
});
test('renderTranscriptLine: tool error content as text blocks', () => {
  const o = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom happened' }] }] } };
  assert.deepEqual(g.renderTranscriptLine(o), ['⚠️ tool error: boom happened']);
});

// ---------------------------------------------------------------------------
// deskUrl — editor deep link
// ---------------------------------------------------------------------------
test('deskUrl: builds the VS Code deep link with the session id', () => {
  const u = g.deskUrl('abc-123-def');
  assert.match(u, /^vscode:\/\/anthropic\.claude-code\/open\?session=abc-123-def$/);
});
test('deskUrl: url-encodes the session id', () => {
  assert.match(g.deskUrl('a b/c'), /session=a%20b%2Fc$/);
});

// ---------------------------------------------------------------------------
// lastExchange — seed a new topic with where the session left off
// ---------------------------------------------------------------------------
test('lastExchange: returns the final user prompt + assistant response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-le-'));
  const f = path.join(dir, 's.jsonl');
  try {
    const lines = [
      { type: 'user', message: { content: 'first question' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } },
      { type: 'user', message: { content: 'second question' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: 'the final answer' }] } },
    ];
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const r = g.lastExchange(f);
    assert.equal(r.lastUser, 'second question');
    assert.equal(r.lastText, 'the final answer');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('lastExchange: missing file is safe', () => {
  assert.deepEqual(g.lastExchange('/nope/missing.jsonl'), { lastText: null, lastUser: null });
});

// ---------------------------------------------------------------------------
// heldByOtherPids — self-pid filtering (the spurious-fork fix)
// ---------------------------------------------------------------------------
test('heldByOtherPids: filters the gateway\'s own pid out of lsof output', () => {
  assert.deepEqual(g.heldByOtherPids('123\n456\n', 456), [123]);      // other holder remains
  assert.deepEqual(g.heldByOtherPids('456\n', 456), []);              // only self → not held
  assert.deepEqual(g.heldByOtherPids('', 456), []);                   // nobody → not held
  assert.deepEqual(g.heldByOtherPids('123\n789\n', 456), [123, 789]); // multiple others
  assert.deepEqual(g.heldByOtherPids('garbage\n123\n', 456), [123]);  // non-numeric lines ignored
});

// ---------------------------------------------------------------------------
// Stall/approval notices — updatePendingTools + dueStallNotices
// ---------------------------------------------------------------------------
test('updatePendingTools: tracks tool_use, clears on tool_result', () => {
  const state = {};
  const t0 = 1000;
  g.updatePendingTools(state, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
  ], t0);
  assert.ok(state.tu1, 'pending after tool_use');
  assert.equal(state.tu1.name, 'Bash');
  const resolved = g.updatePendingTools(state, [
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
  ], t0 + 500);
  assert.equal(state.tu1, undefined, 'cleared after tool_result');
  assert.deepEqual(resolved, [], 'not announced → no resolution notice');
});
test('updatePendingTools: resolution of a NOTIFIED entry is returned for announcement', () => {
  const state = { tu1: { name: 'Bash', summary: 'x', ts: 0, notified: true } };
  const resolved = g.updatePendingTools(state, [
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } },
  ], 99999);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].name, 'Bash');
});
test('dueStallNotices: fires once past threshold, never twice', () => {
  const state = { tu1: { name: 'Bash', summary: 'slow', ts: 0, notified: false } };
  assert.equal(g.dueStallNotices(state, 30_000, 60_000).length, 0, 'below threshold');
  const due = g.dueStallNotices(state, 61_000, 60_000);
  assert.equal(due.length, 1, 'fires at threshold');
  assert.equal(g.dueStallNotices(state, 120_000, 60_000).length, 0, 'does not repeat');
});
test('dueStallNotices: disabled threshold or missing state is safe', () => {
  assert.deepEqual(g.dueStallNotices({ a: { ts: 0, notified: false } }, 99999, 0), []);
  assert.deepEqual(g.dueStallNotices(undefined, 99999, 60_000), []);
});

// ---------------------------------------------------------------------------
// Phone approvals — createApprovalRegistry
// ---------------------------------------------------------------------------
test('approvalRegistry: resolve allows and returns meta once', async () => {
  const reg = g.createApprovalRegistry();
  const { id, promise } = reg.create({ chatId: 'c', threadId: 7 }, 0);
  const meta = reg.resolve(id, true, 'user1');
  assert.deepEqual(meta, { chatId: 'c', threadId: 7 });
  const res = await promise;
  assert.equal(res.allowed, true);
  assert.equal(res.by, 'user1');
  assert.equal(reg.resolve(id, false), null, 'second resolve is a no-op');
  assert.equal(reg.size(), 0);
});
test('approvalRegistry: times out to a deny', async () => {
  const reg = g.createApprovalRegistry();
  const { promise } = reg.create({ chatId: 'c', threadId: 7 }, 30);
  const res = await promise;
  assert.equal(res.allowed, false);
  assert.equal(res.timedOut, true);
  assert.equal(reg.size(), 0, 'timed-out entry cleaned up');
});
test('approvalRegistry: deny resolution', async () => {
  const reg = g.createApprovalRegistry();
  const { id, promise } = reg.create({}, 0);
  reg.resolve(id, false, 'user1');
  const res = await promise;
  assert.equal(res.allowed, false);
  assert.ok(!res.timedOut);
});

// ---------------------------------------------------------------------------
// Cost containment: the titling turn and topic-creation retries
// ---------------------------------------------------------------------------

test('titleArgs: isolates the titling turn from the user MCP/CLAUDE.md surface', () => {
  const a = g.titleArgs('tmp-id', 'haiku');
  const joined = a.join(' ');
  // Without these the throwaway titler inherits every MCP server, skill and CLAUDE.md
  // the user has installed — measured at ~64k tokens to produce a three-word slug.
  assert.ok(joined.includes('--strict-mcp-config'), 'must not load user MCP servers');
  assert.ok(joined.includes('--mcp-config {"mcpServers":{}}'), 'must pass an empty MCP config');
  assert.ok(a.includes('--allowedTools'), 'must not load tool definitions');
  assert.ok(a.includes('--max-turns'), 'must be capped at one turn');
  assert.ok(a.includes('--exclude-dynamic-system-prompt-sections'));
  assert.ok(a.includes('--disable-slash-commands'), 'must not load the skills index');
  assert.ok(a.includes('--setting-sources'), 'must not load user/project settings');
  assert.equal(a[a.indexOf('--model') + 1], 'haiku');
  assert.equal(a[a.indexOf('--session-id') + 1], 'tmp-id');
});

test('topicCooldown: a failed creation is not retried on the very next tick', () => {
  const cd = g.createTopicCooldown(1000, 60000);
  assert.equal(cd.blocked('s1', 0), false, 'first attempt is allowed');
  cd.fail('s1', 0, 0);
  assert.equal(cd.blocked('s1', 500), true, 'blocked immediately after a failure');
  assert.equal(cd.blocked('s1', 1500), false, 'allowed again after the backoff elapses');
});

test('topicCooldown: backoff grows and honours Telegram retry_after', () => {
  const cd = g.createTopicCooldown(1000, 60000);
  cd.fail('s1', 0, 0);
  cd.fail('s1', 0, 0);
  assert.equal(cd.blocked('s1', 1500), true, 'second failure backs off further than the first');
  const cd2 = g.createTopicCooldown(1000, 60000);
  cd2.fail('s2', 38000, 0);            // Telegram said "retry after 38"
  assert.equal(cd2.blocked('s2', 30000), true, 'respects a retry_after longer than the backoff');
  assert.equal(cd2.blocked('s2', 39000), false);
});

test('topicCooldown: caps at the ceiling and clears on success', () => {
  const cd = g.createTopicCooldown(1000, 5000);
  for (let i = 0; i < 20; i++) cd.fail('s1', 0, 0);
  assert.equal(cd.blocked('s1', 5001), false, 'never backs off past the ceiling');
  cd.fail('s1', 0, 0);
  cd.clear('s1');
  assert.equal(cd.blocked('s1', 0), false, 'success clears the cooldown');
});

test('parseRetryAfter: pulls the delay out of a Telegram 429 description', () => {
  assert.equal(g.parseRetryAfter('Too Many Requests: retry after 38'), 38000);
  assert.equal(g.parseRetryAfter('Bad Request: TOPIC_NOT_MODIFIED'), 0);
  assert.equal(g.parseRetryAfter(undefined), 0);
});

test('getUpdates long-poll must complete inside the socket timeout', () => {
  // A 30s server-side long-poll behind a 15s socket timeout can never return when the
  // update queue is idle — it wedges permanently and lastUpdateId never advances.
  assert.ok(g.UPDATE_POLL_TIMEOUT_S * 1000 < g.updateSocketTimeoutMs(),
    `long-poll ${g.UPDATE_POLL_TIMEOUT_S}s must be shorter than socket timeout ${g.updateSocketTimeoutMs()}ms`);
});

test('gateway.js is requirable without config.json (CI has no config — it is gitignored)', () => {
  // Regression: gateway.js used to process.exit(1) at require-time when config.json was
  // absent, so `npm test` failed in CI and every tagged release silently failed to publish.
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-noconfig-'));
  fs.copyFileSync(path.join(__dirname, '..', 'gateway.js'), path.join(tmp, 'gateway.js'));
  const r = require('child_process').spawnSync(
    process.execPath, ['-e', `require(${JSON.stringify(path.join(tmp, 'gateway.js'))})`],
    { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.status, 0, `requiring without config.json exited ${r.status}: ${r.stderr || r.stdout}`);
});

// ---------------------------------------------------------------------------
// State lives outside the install dir (npm update replaces __dirname wholesale)
// ---------------------------------------------------------------------------

function tmpdir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `gw-${tag}-`)); }

test('STATE_DIR is outside the install directory', () => {
  assert.ok(!g.STATE_DIR.startsWith(__dirname), `${g.STATE_DIR} must not live under the package dir`);
  assert.ok(g.STATE_DIR.includes('.claude-gateway'));
});

test('migrateStateFiles: moves legacy state out of the install dir', () => {
  const from = tmpdir('from'), to = tmpdir('to');
  fs.writeFileSync(path.join(from, 'config.json'), '{"BOT_TOKEN":"x"}');
  fs.writeFileSync(path.join(from, 'links.json'), '{"s":{"threadId":1}}');
  const moved = g.migrateStateFiles(from, to);
  assert.deepEqual(moved.sort(), ['config.json', 'links.json']);
  assert.equal(fs.readFileSync(path.join(to, 'config.json'), 'utf8'), '{"BOT_TOKEN":"x"}');
  assert.ok(!fs.existsSync(path.join(from, 'config.json')), 'source removed so npm update cannot resurrect it');
});

test('migrateStateFiles: never clobbers state already in the destination', () => {
  const from = tmpdir('from'), to = tmpdir('to');
  fs.writeFileSync(path.join(from, 'config.json'), '{"BOT_TOKEN":"OLD"}');
  fs.writeFileSync(path.join(to, 'config.json'), '{"BOT_TOKEN":"CURRENT"}');
  const moved = g.migrateStateFiles(from, to);
  assert.deepEqual(moved, []);
  assert.equal(fs.readFileSync(path.join(to, 'config.json'), 'utf8'), '{"BOT_TOKEN":"CURRENT"}');
});

test('migrateStateFiles: idempotent and safe on a missing source dir', () => {
  const from = tmpdir('from'), to = tmpdir('to');
  fs.writeFileSync(path.join(from, 'links.json'), '{}');
  assert.deepEqual(g.migrateStateFiles(from, to), ['links.json']);
  assert.deepEqual(g.migrateStateFiles(from, to), [], 'second run is a no-op');
  assert.deepEqual(g.migrateStateFiles(path.join(from, 'nope'), to), [], 'missing source dir does not throw');
});

test('migrateStateFiles: works across filesystems (copy+unlink, not rename)', () => {
  // rename(2) fails with EXDEV across devices; a global npm prefix and $HOME can differ.
  const from = tmpdir('from'), to = tmpdir('to');
  fs.writeFileSync(path.join(from, 'ignored.json'), '["a"]');
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; };
  try {
    assert.deepEqual(g.migrateStateFiles(from, to), ['ignored.json']);
    assert.equal(fs.readFileSync(path.join(to, 'ignored.json'), 'utf8'), '["a"]');
  } finally { fs.renameSync = realRename; }
});

// ---------------------------------------------------------------------------
// Settle-then-rename: name a topic once the session has real substance
// ---------------------------------------------------------------------------

const userLine = (t) => ({ type: 'user', message: { content: t } });

test('countUserTurns: counts real desk prompts only', () => {
  const lines = [
    userLine('first real prompt'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
    userLine('second real prompt'),
    { type: 'user', isMeta: true, message: { content: 'meta noise' } },          // meta
    { type: 'user', message: { content: '<command-name>/foo</command-name>' } }, // command envelope
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }, // tool result
    userLine('   '),                                                              // whitespace only
  ];
  assert.equal(g.countUserTurns(lines), 2);
});

test('countUserTurns: array-content text blocks count', () => {
  assert.equal(g.countUserTurns([{ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }]), 1);
});

test('dueForRename: fires once at the threshold, never twice', () => {
  const link = { userTurns: 0, renamed: false };
  link.userTurns = 2;
  assert.equal(g.dueForRename(link, 3), false, 'below threshold');
  link.userTurns = 3;
  assert.equal(g.dueForRename(link, 3), true, 'at threshold');
  link.renamed = true;
  assert.equal(g.dueForRename(link, 3), false, 'already renamed — never again');
});

test('dueForRename: disabled when threshold is 0', () => {
  assert.equal(g.dueForRename({ userTurns: 99, renamed: false }, 0), false);
});

test('dueForRename: tolerates a link from an older version with no counter', () => {
  assert.equal(g.dueForRename({}, 3), false);
});

// ---------------------------------------------------------------------------
// doctor.sh — machine diagnostic
// ---------------------------------------------------------------------------

// Runs test/doctor.sh against a fixture $HOME with a stub `npm` on PATH, so the
// "global npm install" branch is exercised without touching the real machine.
function runDoctor({ home, npmRoot, shell = '/bin/bash' }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-bin-'));
  fs.writeFileSync(path.join(bin, 'npm'),
    `#!/bin/sh\n[ "$1" = root ] && echo '${npmRoot || ''}'\nexit 0\n`, { mode: 0o755 });
  const r = require('child_process').spawnSync(
    shell, [path.join(__dirname, 'doctor.sh')],
    { encoding: 'utf8', env: { ...process.env, HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_GATEWAY_DIR: path.join(home, '.claude-gateway') } });
  return r.stdout;
}

// Builds a fake install dir containing the two files doctor.sh probes for.
function fakeInstall(dir, version, log) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gateway.js'), '// stub');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  if (log !== undefined) fs.writeFileSync(path.join(dir, 'gateway.log'), log);
  return dir;
}

test('doctor: reports BOTH a git checkout and an npm install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const npmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-nr-'));
  fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  fakeInstall(path.join(npmRoot, 'claude-code-telegram-gateway'), '1.0.0', '');
  const out = runDoctor({ home, npmRoot });
  assert.match(out, /telegram_gateway {2}v1\.0\.5/, 'checkout listed with its version');
  assert.match(out, /claude-code-telegram-gateway {2}v1\.0\.0/, 'npm install listed too');
});

test('doctor: reports per-install log counts without double zeros', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', 'nothing interesting here\n');
  const out = runDoctor({ home, npmRoot: '' });
  assert.match(out, /retry storms 0 {2}poll timeouts 0/, 'counts render on one line');
  assert.ok(!/^\s*0\s*$/m.test(out), 'no stray bare-zero line from `grep -c || echo 0`');
});

test('doctor: says so plainly when nothing is installed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const out = runDoctor({ home, npmRoot: '' });
  assert.match(out, /installs:\s*\n\s*NONE FOUND/);
});

test('doctor: no zsh unmatched-glob error when the projects dir is empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', `-${home.replace(/^\//, '').replace(/[/.]/g, '-')}`), { recursive: true });
  const out = runDoctor({ home, npmRoot: '', shell: '/bin/zsh' });
  assert.match(out, /orphaned titlers: 0/);
  assert.ok(!/no matches found/.test(out));
});

test('doctor: marks the install a running gateway was launched from', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  // A real, long-lived process whose argv contains <dir>/gateway.js, so pgrep finds it.
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.match(out, new RegExp(`v1\\.0\\.5\\s+<- running \\(pid ${child.pid}\\)`),
      'the running install is marked with its pid');
  } finally { child.kill('SIGKILL'); }
});

test('doctor: leaves installs unmarked when nothing is running from them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  const out = runDoctor({ home, npmRoot: '' });
  assert.ok(!/<- running/.test(out), 'no false positive from an unrelated gateway elsewhere');
});
