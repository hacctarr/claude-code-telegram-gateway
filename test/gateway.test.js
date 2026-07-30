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

test('createFeed: separates tool activity from streamed prose with a blank line', () => {
  const feed = g.createFeed(true);
  for (const e of EVENTS) feed.handle(e);
  // Readout separation: tool block above, prose response below, divided by a blank line.
  assert.equal(feed.render(), '🔧 Bash: echo hi\n\nHello world');
});
test('createFeed: prose stays grouped even when a tool arrives mid-stream', () => {
  const feed = g.createFeed(true);
  feed.handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me check.' } } });
  feed.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } }] } });
  feed.handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Done.' } } });
  // Tools bucket above, all prose below — not interleaved.
  assert.equal(feed.render(), '🔧 Read: /a.js\n\nLet me check. Done.');
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
// splitReadout — partition mirror posts into activity vs prose messages
// ---------------------------------------------------------------------------
test('splitReadout: tool lines go to activity, prose to prose', () => {
  assert.deepEqual(
    g.splitReadout(['🔧 Bash: echo hi', 'Hello there']),
    { activity: ['🔧 Bash: echo hi'], prose: ['Hello there'] });
});
test('splitReadout: desk / error / finished / stall lines are all activity', () => {
  const posts = ['🖥️ desk: Fix the bug', '⚠️ tool error: boom', '▶️ Read finished — session continuing.', '⏳ Desk session has been on this for 90s'];
  assert.deepEqual(g.splitReadout(posts), { activity: posts, prose: [] });
});
test('splitReadout: order is preserved within each bucket', () => {
  assert.deepEqual(
    g.splitReadout(['🔧 Read: /a.js', 'first prose', '🔧 Bash: ls', 'second prose']),
    { activity: ['🔧 Read: /a.js', '🔧 Bash: ls'], prose: ['first prose', 'second prose'] });
});
test('splitReadout: prose-only and activity-only degrade cleanly', () => {
  assert.deepEqual(g.splitReadout(['just prose']), { activity: [], prose: ['just prose'] });
  assert.deepEqual(g.splitReadout(['🔧 Bash: ls']), { activity: ['🔧 Bash: ls'], prose: [] });
  assert.deepEqual(g.splitReadout([]), { activity: [], prose: [] });
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
test('isActive / shouldPrune / isDeskBusy boundaries (defaults 30m / 2h / 15s)', () => {
  const now = Date.now();
  assert.equal(g.isActive(now - 60_000, now), true);           // 1m ago -> active
  assert.equal(g.isActive(now - 40 * 60_000, now), false);      // 40m ago -> not
  const win = g.resolvePruneMs({});                             // the default window, not the host's
  assert.equal(g.shouldPrune(now - 30 * 60_000, now, win), false); // 30m -> keep
  assert.equal(g.shouldPrune(now - 3 * 3600_000, now, win), true); // 3h -> prune
  assert.equal(g.isDeskBusy(now - 5_000, now), true);           // 5s -> busy
  assert.equal(g.isDeskBusy(now - 60_000, now), false);         // 60s -> idle
});

// ---------------------------------------------------------------------------
// Prune window resolution
// ---------------------------------------------------------------------------
// Days was the wrong unit: a topic whose session went idle in the morning sat in the list all day.
// Hours is what the decision is actually made in, and 2h idle is a comfortable "this one is done".
const H = 3_600_000, D = 86_400_000;

test('resolvePruneMs: defaults to 2 hours when nothing is configured', () => {
  assert.equal(g.resolvePruneMs({}), 2 * H);
  assert.equal(g.resolvePruneMs(), 2 * H);
});

test('resolvePruneMs: honors PRUNE_AFTER_HOURS', () => {
  assert.equal(g.resolvePruneMs({ PRUNE_AFTER_HOURS: 6 }), 6 * H);
  assert.equal(g.resolvePruneMs({ PRUNE_AFTER_HOURS: 0.5 }), 0.5 * H);
});

test('resolvePruneMs: still honors the pre-hours PRUNE_AFTER_DAYS spelling', () => {
  assert.equal(g.resolvePruneMs({ PRUNE_AFTER_DAYS: 1 }), D, 'an existing config keeps its window');
  assert.equal(g.resolvePruneMs({ PRUNE_AFTER_DAYS: 7 }), 7 * D);
});

test('resolvePruneMs: hours wins when a config carries both spellings', () => {
  assert.equal(g.resolvePruneMs({ PRUNE_AFTER_HOURS: 2, PRUNE_AFTER_DAYS: 7 }), 2 * H);
});

test('resolvePruneMs: a nonsensical window falls back to the default rather than pruning everything', () => {
  for (const bad of [0, -3, 'soon', null, NaN, Infinity]) {
    assert.equal(g.resolvePruneMs({ PRUNE_AFTER_HOURS: bad }), 2 * H, `PRUNE_AFTER_HOURS=${String(bad)}`);
    assert.equal(g.resolvePruneMs({ PRUNE_AFTER_DAYS: bad }), 2 * H, `PRUNE_AFTER_DAYS=${String(bad)}`);
  }
});

test('formatPruneWindow: reads in the unit it was configured in', () => {
  assert.equal(g.formatPruneWindow(2 * H), '2h');
  assert.equal(g.formatPruneWindow(D), '24h');
  assert.equal(g.formatPruneWindow(0.5 * H), '30m');
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
test('topicName: slugifies the label as plain text (icon carried separately), falls back to short id', () => {
  assert.equal(g.topicName({ id: 'abcdef12-0000', label: 'Fix login' }), 'fix-login');
  assert.equal(g.topicName({ id: 'abcdef12-0000', label: 'weekly review' }), 'weekly-review');
  assert.match(g.topicName({ id: 'abcdef12-0000', label: '' }), /^claude-abcdef$/);
});
test('pickIcon: keyword match wins with a real custom-emoji id, 🤖 default otherwise', () => {
  const bug = g.pickIcon('fix the login crash');
  assert.equal(bug.emoji, '🦠');
  assert.match(bug.id, /^\d+$/);          // a real getForumTopicIconStickers id
  assert.equal(g.pickIcon('deploy to fly').emoji, '🏁');
  assert.equal(g.pickIcon('sort the gmail inbox').emoji, '💬');
  assert.equal(g.pickIcon('quarterly budget').emoji, '💰');
  assert.equal(g.pickIcon('chat about the weather').emoji, '🤖');
  assert.equal(g.pickIcon('chat about the weather').id, '5309832892262654231');
  assert.equal(g.pickIcon('').emoji, '🤖');
  assert.equal(g.pickEmoji('fix the login crash'), '🦠');   // back-compat shim
});
test('openerText: minimal (default) is one identifying line, no how-it-works paragraph', () => {
  const t = g.openerText({ id: 'abcdef12-3456', label: 'Fix login', mtime: Date.now() });
  assert.match(t, /abcdef12/);
  assert.match(t, /Fix login/);
  assert.match(t, /mirroring live/);
  assert.doesNotMatch(t, /\bcr\b/);        // no resume paragraph in minimal
  assert.ok(!t.includes('\n'), 'minimal opener is a single line');
});
test('openerText: full mode keeps the how-it-works paragraph and cr hint', () => {
  const t = g.openerText({ id: 'abcdef12-3456', label: 'Fix login', mtime: Date.now() }, 'full');
  assert.match(t, /abcdef12/);
  assert.match(t, /cr/);
  assert.match(t, /mirrors the desk session live/);
});
test('openerText: off mode posts nothing', () => {
  assert.equal(g.openerText({ id: 'abcdef12-3456', label: 'x', mtime: Date.now() }, 'off'), '');
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
// contextTokens: how full a session's context is, for modules that act on it
// ---------------------------------------------------------------------------
const usageLine = (u) => JSON.stringify({ type: 'assistant', message: { usage: u } });

test('contextTokens: sums the last assistant turn\'s input + cache tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ct-'));
  const f = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(f, [
      usageLine({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 90 }),
      usageLine({ input_tokens: 2, cache_read_input_tokens: 128827, cache_creation_input_tokens: 1661, output_tokens: 1153 }),
    ].join('\n') + '\n');
    assert.equal(g.contextTokens(f), 130490);   // last turn only; output_tokens excluded
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contextTokens: ignores sidechain (subagent) turns, which have their own context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ct2-'));
  const f = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(f, [
      usageLine({ input_tokens: 1, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 1, cache_read_input_tokens: 999999 } } }),
    ].join('\n') + '\n');
    assert.equal(g.contextTokens(f), 50001);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contextTokens: a transcript with no usage, and a missing file, both read as 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ct3-'));
  const f = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    assert.equal(g.contextTokens(f), 0);
    assert.equal(g.contextTokens('/nope/missing.jsonl'), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

// The titling turn hardcoded `--permission-mode bypassPermissions`. It is a
// throwaway turn with no tools and no MCP, so it can do nothing, but a laptop under
// managed policy is not allowed to pass that mode at all and had no way to opt out:
// every other spawn path honours PERMISSION_MODE and this one did not.
test('titleArgs: honours the configured permission mode instead of hardcoding bypass', () => {
  const modeOf = (args) => args[args.indexOf('--permission-mode') + 1];
  assert.strictEqual(modeOf(g.titleArgs('tmp-id', 'haiku', 'acceptEdits')), 'acceptEdits',
    'the titling turn must take the configured mode, not a hardcoded one');
  // And the default must be the gateway's own resolved mode, so a machine that sets
  // PERMISSION_MODE gets it here too without passing anything.
  assert.strictEqual(modeOf(g.titleArgs('tmp-id', 'haiku')), g.PERM_MODE,
    'the default must follow PERMISSION_MODE, which is what a managed machine sets');
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
  fs.copyFileSync(path.join(__dirname, '..', 'telemetry.js'), path.join(tmp, 'telemetry.js'));
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

// Runs under zsh deliberately: the unmatched-glob failure this guards is zsh-specific
// (bash passes an unmatched glob through, zsh aborts), and the paste-into-a-terminal
// path is zsh on macOS. CI runs on Linux with no /bin/zsh, so skip rather than fail —
// spawnSync on a missing shell returns undefined stdout, which read as a real failure
// and silently aborted the v1.0.6 publish.
test('doctor: no zsh unmatched-glob error when the projects dir is empty',
  { skip: fs.existsSync('/bin/zsh') ? false : 'no /bin/zsh on this machine' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', `-${home.replace(/^\//, '').replace(/[/.]/g, '-')}`), { recursive: true });
  const out = runDoctor({ home, npmRoot: '', shell: '/bin/zsh' });
  assert.match(out, /orphaned titlers: 0/);
  assert.ok(!/no matches found/.test(out));
});

// The projects dir holds a .jsonl for EVERY Claude Code session run from that cwd,
// not just titler spawns. Counting all of them reported 300 "orphaned titlers" on a
// machine whose real titler count was 0 — the diagnostic overstated the burn it exists
// to measure. Only sessions carrying the titling prompt count.
test('doctor: counts only titler sessions, not every session in the projects dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const proj = path.join(home, '.claude', 'projects',
    `-${home.replace(/^\//, '').replace(/[/.]/g, '-')}`);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'titler-a.jsonl'), JSON.stringify(
    { type: 'user', message: { content: 'Give a 1-3 word kebab-case slug titling this work session. Reply ONLY the slug, no quotes or extra text.' } }) + '\n');
  fs.writeFileSync(path.join(proj, 'real-work-1.jsonl'), JSON.stringify(
    { type: 'user', message: { content: 'refactor the billing module' } }) + '\n');
  fs.writeFileSync(path.join(proj, 'real-work-2.jsonl'), JSON.stringify(
    { type: 'user', message: { content: 'why is the deploy failing' } }) + '\n');
  const out = runDoctor({ home, npmRoot: '' });
  assert.match(out, /orphaned titlers: 1\b/, 'one titler, not three sessions');
  assert.match(out, /of 3 sessions/, 'total still reported, so the ratio is visible');
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

test('doctor: a process merely referencing gateway.js.log does not count as running', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.0.5', '');
  // A real, long-lived process whose argv contains <dir>/gateway.js.log — a near miss:
  // it has "<install>/gateway.js" as a substring, but as part of a longer token
  // (e.g. what `tail -f`, `vim`, or `git diff` on the log file would look like).
  // pgrep -f 'gateway\.js' finds it too, since the pattern is unanchored.
  const logPath = path.join(dir, 'gateway.js.log');
  const child = require('child_process').spawn(process.execPath,
    ['-e', 'setTimeout(()=>{},60000)', '--', logPath], { stdio: 'ignore' });
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.ok(!/<- running/.test(out),
      'a substring match on gateway.js.log must not mark the install as running');
  } finally { child.kill('SIGKILL'); }
});

// --- Running-version marker (version drift) --------------------------------
// The gateway loads gateway.js once at boot and holds it in memory; `npm update`
// or `git pull` changes the on-disk copy without touching the live process. The
// on-disk package.json version then lies about what's actually running. The boot
// marker records the version the live process loaded so doctor can flag the gap.
test('writeRunningMarker: records the loaded version, pid, and dir', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-state-'));
  const m = g.writeRunningMarker(stateDir);
  const pkg = require('../package.json');
  assert.equal(m.version, pkg.version, 'records this package version');
  assert.equal(m.pid, process.pid, 'records this process pid');
  assert.equal(m.dir, path.dirname(require.resolve('../gateway.js')), 'records the install dir');
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'running.json'), 'utf8'));
  assert.deepEqual(onDisk, m, 'persists exactly what it returns');
});

test('doctor: flags version drift when the live process loaded an older version than what is on disk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.2.1', '');   // on-disk = new
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  const stateDir = path.join(home, '.claude-gateway');
  fs.mkdirSync(stateDir, { recursive: true });
  // the live process loaded 1.2.0; disk now holds 1.2.1
  fs.writeFileSync(path.join(stateDir, 'running.json'),
    JSON.stringify({ version: '1.2.0', pid: child.pid, dir, startedAt: '2026-07-24T00:00:00.000Z' }));
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.match(out, /loaded v1\.2\.0/, 'names the version the process is actually running');
    assert.match(out, /restart to load/, 'tells the user how to close the gap');
  } finally { child.kill('SIGKILL'); }
});

test('doctor: no drift warning when the loaded version matches on disk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.2.1', '');
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  const stateDir = path.join(home, '.claude-gateway');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'running.json'),
    JSON.stringify({ version: '1.2.1', pid: child.pid, dir, startedAt: '2026-07-24T00:00:00.000Z' }));
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.match(out, /v1\.2\.1\s+<- running/, 'still marked running');
    assert.ok(!/restart to load/.test(out), 'no false drift warning when versions agree');
  } finally { child.kill('SIGKILL'); }
});

// Version drift only fires when package.json moved. During active development a `git pull` changes
// gateway.js and leaves the version alone, which is the case that actually bit: the live gateway ran
// pre-fix code for an hour while the checkout was several merges ahead, versions identical
// throughout. Hashing the loaded file closes that blind spot.
function markerFor(stateDir, { version, pid, dir, sha }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const m = { version, pid, dir, startedAt: '2026-07-24T00:00:00.000Z' };
  if (sha !== undefined) m.sha = sha;
  fs.writeFileSync(path.join(stateDir, 'running.json'), JSON.stringify(m));
}
const sha256of = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('writeRunningMarker: records a hash of the gateway.js it loaded', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-state-'));
  const m = g.writeRunningMarker(stateDir);
  assert.equal(m.sha, sha256of(require.resolve('../gateway.js')), 'hashes the file this process loaded');
});

test('doctor: flags code drift when gateway.js changed but the version did not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.2.1', '');
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  // same version on both sides; the loaded hash is from a gateway.js that has since been edited
  markerFor(path.join(home, '.claude-gateway'), { version: '1.2.1', pid: child.pid, dir, sha: 'a'.repeat(64) });
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.match(out, /restart to load/, 'names the gap even though the versions agree');
    assert.match(out, /gateway\.js on disk differs/, 'says it is the code, not the version');
  } finally { child.kill('SIGKILL'); }
});

test('doctor: no code-drift warning when the loaded hash still matches disk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.2.1', '');
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  markerFor(path.join(home, '.claude-gateway'),
    { version: '1.2.1', pid: child.pid, dir, sha: sha256of(path.join(dir, 'gateway.js')) });
  try {
    assert.ok(!/restart to load/.test(runDoctor({ home, npmRoot: '' })), 'nothing drifted');
  } finally { child.kill('SIGKILL'); }
});

test('doctor: a marker predating the hash field reports no code drift', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.2.1', '');
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  markerFor(path.join(home, '.claude-gateway'), { version: '1.2.1', pid: child.pid, dir });   // no sha
  try {
    assert.ok(!/restart to load/.test(runDoctor({ home, npmRoot: '' })),
      'an older marker cannot prove drift, so it must not claim any');
  } finally { child.kill('SIGKILL'); }
});

test('doctor: ignores a stale running.json whose pid is not the live gateway', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-home-'));
  const dir = fakeInstall(path.join(home, 'telegram_gateway'), '1.2.1', '');
  fs.writeFileSync(path.join(dir, 'gateway.js'), 'setTimeout(()=>{},60000)');
  const child = require('child_process').spawn(process.execPath, [path.join(dir, 'gateway.js')], { stdio: 'ignore' });
  const stateDir = path.join(home, '.claude-gateway');
  fs.mkdirSync(stateDir, { recursive: true });
  // marker left by a previous, now-dead process (different pid): must not be trusted
  fs.writeFileSync(path.join(stateDir, 'running.json'),
    JSON.stringify({ version: '1.0.0', pid: child.pid + 100000, dir, startedAt: '2026-07-24T00:00:00.000Z' }));
  try {
    const out = runDoctor({ home, npmRoot: '' });
    assert.ok(!/restart to load/.test(out), 'a marker from another pid is not evidence of drift');
  } finally { child.kill('SIGKILL'); }
});

// --- Inline action buttons (Task 1) ----------------------------------------
test('chunkText: short text is a single chunk', () => {
  assert.deepEqual(g.chunkText('hello'), ['hello']);
});

test('chunkText: splits on a newline near the limit', () => {
  const a = 'a'.repeat(3000);
  const b = 'b'.repeat(2000);
  const chunks = g.chunkText(`${a}\n${b}`, 4000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});

test('chunkText: empty string yields no chunks', () => {
  assert.deepEqual(g.chunkText(''), []);
});

test('parseActionCallback: extracts action and session id', () => {
  assert.deepEqual(g.parseActionCallback('act:desk:abc-123'), { action: 'desk', sid: 'abc-123' });
  assert.deepEqual(g.parseActionCallback('act:resume:11111111-2222-3333-4444-555555555555'),
    { action: 'resume', sid: '11111111-2222-3333-4444-555555555555' });
});

test('parseActionCallback: rejects non-act and unknown actions', () => {
  assert.equal(g.parseActionCallback('ap:5:1'), null);
  assert.equal(g.parseActionCallback('act:frobnicate:x'), null);
  assert.equal(g.parseActionCallback('act:desk:'), null);
  assert.equal(g.parseActionCallback(''), null);
  assert.equal(g.parseActionCallback(undefined), null);
});

test('buildSessionActionBar: three buttons with act: callbacks', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  const bar = g.buildSessionActionBar(sid);
  const row = bar.inline_keyboard[0];
  assert.equal(row.length, 3);
  assert.deepEqual(row.map((b) => b.callback_data),
    [`act:desk:${sid}`, `act:rename:${sid}`, `act:exit:${sid}`]);
  for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});

test('buildSessionActionBar: null when sid is falsy', () => {
  assert.equal(g.buildSessionActionBar(''), null);
  assert.equal(g.buildSessionActionBar(undefined), null);
});

test('buildSessionPickerKeyboard: one row per session, callbacks within 64 bytes', () => {
  const sessions = [
    { id: '11111111-2222-3333-4444-555555555555', label: 'fix the parser', mtime: Date.now() },
    { id: '99999999-8888-7777-6666-555555555555', label: 'write docs', mtime: Date.now() - 3600_000 },
  ];
  const kb = g.buildSessionPickerKeyboard(sessions);
  assert.equal(kb.inline_keyboard.length, 2);
  assert.equal(kb.inline_keyboard[0][0].callback_data, `act:resume:${sessions[0].id}`);
  for (const row of kb.inline_keyboard) assert.ok(Buffer.byteLength(row[0].callback_data) <= 64);
});

test('buildSessionPickerKeyboard: caps at max rows and returns null when empty', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, label: `s${i}`, mtime: Date.now() }));
  assert.equal(g.buildSessionPickerKeyboard(many, 12).inline_keyboard.length, 12);
  assert.equal(g.buildSessionPickerKeyboard([]), null);
});

// --- Group auto-config: pure helpers (Task 3) ------------------------------
test('buildCommandList: seven commands, lowercase names, non-empty descriptions', () => {
  const cmds = g.buildCommandList();
  assert.equal(cmds.length, 8);
  assert.deepEqual(cmds.map((c) => c.command), ['new', 'sessions', 'desk', 'rename', 'exit', 'tools', 'resume', 'stats']);
  for (const c of cmds) {
    assert.match(c.command, /^[a-z]+$/);
    assert.ok(c.description.length > 0 && c.description.length <= 256);
  }
});

test('appearanceHash: stable for same input, changes when any field changes', () => {
  const a = g.appearanceHash({ title: 'x', description: 'y', photoSha: 'z', commands: g.buildCommandList() });
  const b = g.appearanceHash({ title: 'x', description: 'y', photoSha: 'z', commands: g.buildCommandList() });
  const c = g.appearanceHash({ title: 'x', description: 'CHANGED', photoSha: 'z', commands: g.buildCommandList() });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('resolveBotProfile: nulls when unset, values when set', () => {
  assert.deepEqual(g.resolveBotProfile({}), { name: null, about: null, description: null });
  assert.deepEqual(
    g.resolveBotProfile({ bot_name: 'N', bot_about: 'A', bot_description: 'D' }),
    { name: 'N', about: 'A', description: 'D' });
});

test('resolveChatAppearance: pulls the per-chat entry, defaults title/description to null', () => {
  const appearance = { chats: { '-100': { title: 'T', description: 'D' } } };
  const r = g.resolveChatAppearance(appearance, '-100', 'sha123');
  assert.equal(r.title, 'T');
  assert.equal(r.description, 'D');
  assert.equal(r.photoSha, 'sha123');
  assert.equal(r.commands.length, 8);
  const missing = g.resolveChatAppearance(appearance, '-999', '');
  assert.equal(missing.title, null);
  assert.equal(missing.description, null);
});

test('chatPhotoPath: per-chat overrides default, null when neither set', () => {
  assert.equal(g.chatPhotoPath({ default_photo_path: 'd.png', chats: {} }, '-1'), 'd.png');
  assert.equal(g.chatPhotoPath({ default_photo_path: 'd.png', chats: { '-1': { photo_path: 'c.png' } } }, '-1'), 'c.png');
  assert.equal(g.chatPhotoPath({ chats: {} }, '-1'), null);
});

test('restartReady: honors the flag only when no injected turn is in flight', () => {
  assert.equal(g.restartReady('/x/restart.flag', 0), true);
  assert.equal(g.restartReady('/x/restart.flag', 1), false);   // a phone turn is mid-reply — wait
  assert.equal(g.restartReady('/x/restart.flag', 3), false);
});

test('restartReady: no flag means no restart, regardless of injection count', () => {
  assert.equal(g.restartReady(null, 0), false);
  assert.equal(g.restartReady(undefined, 0), false);
  assert.equal(g.restartReady('', 0), false);
});

test('createInjectionSet: behaves as a set for mirror suppression', () => {
  let t = 1000;
  const inj = g.createInjectionSet(() => t);
  assert.equal(inj.size, 0);
  inj.add('a'); inj.add('b');
  assert.equal(inj.has('a'), true);
  assert.equal(inj.has('zzz'), false);
  assert.equal(inj.size, 2);
  inj.delete('a');
  assert.equal(inj.has('a'), false);
  assert.equal(inj.size, 1);
});

test('createInjectionSet: a reservation counts as live until it goes silent', () => {
  let t = 0;
  const inj = g.createInjectionSet(() => t);
  inj.add('sess');
  assert.equal(inj.liveCount(60_000), 1);
  t = 59_999;
  assert.equal(inj.liveCount(60_000), 1);
  t = 60_000;
  assert.equal(inj.liveCount(60_000), 0);   // silent too long to keep blocking a restart
  assert.equal(inj.size, 1);                // the reservation itself is untouched, so the
  assert.equal(inj.has('sess'), true);      // mirror stays suppressed for the hung turn
});

test('createInjectionSet: touch resets the silence window, so a long streaming turn still blocks', () => {
  let t = 0;
  const inj = g.createInjectionSet(() => t);
  inj.add('sess');
  for (let i = 0; i < 10; i++) { t += 50_000; inj.touch('sess'); }   // 500s of steady output
  assert.equal(inj.liveCount(60_000), 1);
  t += 60_000;
  assert.equal(inj.liveCount(60_000), 0);
});

test('createInjectionSet: touch takes every id a turn reserved and ignores absent ones', () => {
  let t = 0;
  const inj = g.createInjectionSet(() => t);
  inj.add('resumed'); inj.add('forked');
  t = 30_000;
  inj.touch('resumed', null, 'forked', 'never-reserved');   // null = an id this turn didn't mint
  assert.equal(inj.has('never-reserved'), false);           // touch must not create a reservation
  t = 89_999;
  assert.equal(inj.liveCount(60_000), 2);
});

test('createInjectionSet: a stale reservation stops blocking, a fresh one alongside it still does', () => {
  let t = 0;
  const inj = g.createInjectionSet(() => t);
  inj.add('hung');
  t = 600_000;
  inj.add('healthy');
  assert.equal(inj.liveCount(60_000), 1);
  assert.equal(g.restartReady('/x/restart.flag', inj.liveCount(60_000)), false);
  t += 60_000;
  assert.equal(inj.liveCount(60_000), 0);
  assert.equal(g.restartReady('/x/restart.flag', inj.liveCount(60_000)), true);
});

// ---------------------------------------------------------------------------
// Partial-send resume (mirror flood guard)
// ---------------------------------------------------------------------------
// A mirror batch that failed partway used to be re-sent whole on the next tick, re-posting every
// chunk that had already landed. Under Telegram's per-chat flood limit the batch could never
// complete, so the retry never stopped: one topic took thousands of duplicate posts.

// Fake transport: `outcomes` is consulted per call — true sends, a number 429s with that retry_after.
function fakeSend(outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    send: async (method, payload) => {
      calls.push(payload.text);
      const o = outcomes[i++];
      if (o === true || o === undefined) return { ok: true, result: { message_id: 100 + i } };
      if (typeof o === 'number') return { ok: false, description: `Too Many Requests: retry after ${o}` };
      throw new Error('ETIMEDOUT');
    },
  };
}

const CH = (n) => Array.from({ length: n }, (_, i) => `chunk${i}`.padEnd(4000, '.')).join('\n');

test('sendChunked: full success reports every chunk delivered', async () => {
  const f = fakeSend([true, true, true]);
  const r = await g.sendChunked('-1', 7, CH(3), { send: f.send });
  assert.equal(r.allSent, true);
  assert.equal(r.sent, 3);
  assert.equal(f.calls.length, 3);
});

test('sendChunked: stops at the first failure instead of hammering the rest of the batch', async () => {
  const f = fakeSend([true, 30, true]);
  const r = await g.sendChunked('-1', 7, CH(3), { send: f.send });
  assert.equal(r.allSent, false);
  assert.equal(r.sent, 1, 'only the first chunk landed');
  assert.equal(f.calls.length, 2, 'aborts after the failure — chunk 3 is never attempted');
  assert.equal(r.retryAfterMs, 30000, 'surfaces the retry_after so the caller can back off');
});

test('sendChunked: a retry skips the chunks that already landed', async () => {
  const first = fakeSend([true, 30]);
  const r1 = await g.sendChunked('-1', 7, CH(3), { send: first.send });
  assert.equal(r1.sent, 1);
  const retry = fakeSend([true, true]);
  const r2 = await g.sendChunked('-1', 7, CH(3), { skip: r1.sent, send: retry.send });
  assert.equal(r2.allSent, true);
  assert.equal(r2.sent, 3);
  assert.equal(retry.calls.length, 2, 'the delivered chunk is not posted a second time');
  assert.ok(!retry.calls.some((c) => c.startsWith('chunk0')), 'chunk 0 was already on Telegram');
});

// A transport error that does not recover still stops the batch and still reports what
// landed. The fixture throws on every attempt deliberately: a single 'throw' no longer ends
// the batch now that transport errors are retried, and with this fixture a lone entry would
// fall off the end of `outcomes` and be answered as a success.
test('sendChunked: an unrecovered transport error stops the batch and keeps the delivered count', async () => {
  const f = fakeSend([true, 'throw', 'throw']);
  const r = await g.sendChunked('-1', 7, CH(3), { send: f.send, sleep: async () => {} });
  assert.equal(r.allSent, false);
  assert.equal(r.sent, 1);
  assert.equal(r.retryAfterMs, 0);
});

// A single transport blip cost a whole flush interval. Measured across the fleet in one
// day: 22 ETIMEDOUT on one laptop, 9 on another, against a host `curl` reaches in under a
// second. The batch resumes on the next tick so nothing is lost, but the mirror stalls and
// the log fills. Retry the transport error itself rather than raising SOCKET_TIMEOUT_MS,
// which is held at 15s deliberately so a hung send cannot stall the poll loop.
test('sendChunked: a transient transport error is retried rather than costing the batch', async () => {
  const f = fakeSend([true, 'throw', true, true]);
  const r = await g.sendChunked('-1', 7, CH(3), { send: f.send, sleep: async () => {} });
  assert.equal(r.allSent, true, 'a blip on chunk 2 must not end the batch');
  assert.equal(r.sent, 3);
  assert.equal(f.calls.length, 4, 'chunk 2 attempted twice, then chunk 3');
});

// The distinction that matters. A 429 is Telegram asking us to slow down, and the caller
// already backs off on retryAfterMs; retrying it here is what earns the next 429.
test('sendChunked: a rate-limit response is NOT retried', async () => {
  const f = fakeSend([true, 30, true, true]);
  const r = await g.sendChunked('-1', 7, CH(3), { send: f.send, sleep: async () => {} });
  assert.equal(r.allSent, false);
  assert.equal(r.sent, 1);
  assert.equal(f.calls.length, 2, 'a 429 aborts immediately, exactly as before');
  assert.equal(r.retryAfterMs, 30000);
});

test('sendChunked: retries are bounded, and a persistent failure still reports what landed', async () => {
  const f = fakeSend([true, 'throw', 'throw', 'throw', 'throw', 'throw']);
  const r = await g.sendChunked('-1', 7, CH(3), { send: f.send, sleep: async () => {} });
  assert.equal(r.allSent, false);
  assert.equal(r.sent, 1, 'the delivered count survives a persistent failure');
  assert.ok(f.calls.length <= 4,
    `retries must be bounded so a dead network cannot stall the loop; got ${f.calls.length} calls`);
});

test('sendChunked: reply markup rides the final chunk only', async () => {
  const seen = [];
  const send = async (method, payload) => { seen.push(!!payload.reply_markup); return { ok: true, result: { message_id: 1 } }; };
  await g.sendChunked('-1', 7, CH(3), { replyMarkup: { inline_keyboard: [] }, send });
  assert.deepEqual(seen, [false, false, true]);
});

test('resumeCursor: keeps the delivered counts while the batch is the same', () => {
  const c = { offset: 500, activity: 2, prose: 1 };
  assert.deepEqual(g.resumeCursor(c, 500), c);
});

test('resumeCursor: resets once the batch advances or when there is no cursor', () => {
  assert.deepEqual(g.resumeCursor({ offset: 500, activity: 2, prose: 1 }, 900), { offset: 900, activity: 0, prose: 0 });
  assert.deepEqual(g.resumeCursor(undefined, 900), { offset: 900, activity: 0, prose: 0 });
});

test('linkCursor: a cursor restored from links.json resumes the batch it belongs to', () => {
  // The in-memory cursor is worthless across the restart it most needs to survive, so it rides the
  // link record into links.json. JSON round-trip stands in for persist + reload.
  const stored = { chatId: '-1', threadId: 7, offset: 500, mirrorCursor: { offset: 900, activity: 2, prose: 1 } };
  const restored = JSON.parse(JSON.stringify({ s: stored })).s;
  assert.deepEqual(g.linkCursor(restored, 900), { offset: 900, activity: 2, prose: 1 },
    'same batch: resume after the 2 activity and 1 prose chunks already delivered');
  assert.deepEqual(g.linkCursor(restored, 1200), { offset: 1200, activity: 0, prose: 0 },
    'the session wrote more, so this is a different batch and the counts reset');
});

test('linkCursor: a link with no stored cursor starts the batch from zero', () => {
  assert.deepEqual(g.linkCursor({}, 900), { offset: 900, activity: 0, prose: 0 });
  assert.deepEqual(g.linkCursor(undefined, 900), { offset: 900, activity: 0, prose: 0 });
});

// ---------------------------------------------------------------------------
// Tool-activity visibility: per-topic / per-chat overrides over the config default
// ---------------------------------------------------------------------------
test('resolveToolActivity: with no overrides the config default decides', () => {
  assert.equal(g.resolveToolActivity({}, '-100', 7, true), true);
  assert.equal(g.resolveToolActivity({}, '-100', 7, false), false);
});

test('resolveToolActivity: a chat override beats the config default', () => {
  const prefs = { chats: { '-100': false }, threads: {} };
  assert.equal(g.resolveToolActivity(prefs, '-100', 7, true), false);
  assert.equal(g.resolveToolActivity(prefs, '-200', 7, true), true, 'scoped to its own chat');
});

test('resolveToolActivity: a topic override beats its chat', () => {
  const prefs = { chats: { '-100': false }, threads: { '-100_7': true } };
  assert.equal(g.resolveToolActivity(prefs, '-100', 7, true), true, 'this one topic stays loud');
  assert.equal(g.resolveToolActivity(prefs, '-100', 8, true), false, 'the rest of the chat stays quiet');
});

test('parseToolsCommand: bare /tools reports the current state', () => {
  assert.deepEqual(g.parseToolsCommand('/tools'), { action: 'show' });
});

test('parseToolsCommand: on/off set this topic, "all" sets the whole chat', () => {
  assert.deepEqual(g.parseToolsCommand('/tools off'), { action: 'set', on: false, scope: 'thread' });
  assert.deepEqual(g.parseToolsCommand('/tools on'), { action: 'set', on: true, scope: 'thread' });
  assert.deepEqual(g.parseToolsCommand('/tools off all'), { action: 'set', on: false, scope: 'chat' });
  assert.deepEqual(g.parseToolsCommand('  /TOOLS   ON   ALL '), { action: 'set', on: true, scope: 'chat' });
});

test('parseToolsCommand: "default" clears an override so the wider scope decides again', () => {
  assert.deepEqual(g.parseToolsCommand('/tools default'), { action: 'clear', scope: 'thread' });
  assert.deepEqual(g.parseToolsCommand('/tools default all'), { action: 'clear', scope: 'chat' });
});

test('parseToolsCommand: an unknown argument asks for help instead of guessing', () => {
  assert.deepEqual(g.parseToolsCommand('/tools maybe'), { action: 'help' });
  assert.deepEqual(g.parseToolsCommand('/tools off everywhere'), { action: 'help' });
});

test('parseToolsCommand: anything that is not the command is ignored', () => {
  assert.equal(g.parseToolsCommand('/toolsmith off'), null);
  assert.equal(g.parseToolsCommand('what tools do you have'), null);
  assert.equal(g.parseToolsCommand(''), null);
  assert.equal(g.parseToolsCommand(undefined), null);
});

test('stripBotMention: strips our own @mention from a command, keeping arguments', () => {
  assert.equal(g.stripBotMention('/exit@Hacctarr_bot', 'Hacctarr_bot'), '/exit');
  assert.equal(g.stripBotMention('/sessions@Hacctarr_bot', 'Hacctarr_bot'), '/sessions');
  assert.equal(g.stripBotMention('/resume@Hacctarr_bot abc def', 'Hacctarr_bot'), '/resume abc def');
  assert.equal(g.stripBotMention('/exit@hacctarr_BOT', 'Hacctarr_bot'), '/exit', 'Telegram usernames are case-insensitive');
});

test('stripBotMention: a command addressed to a different bot is dropped, not forwarded', () => {
  assert.equal(g.stripBotMention('/exit@SomeOther_bot', 'Hacctarr_bot'), null);
});

test('stripBotMention: with our username unknown, a command mention is treated as ours', () => {
  assert.equal(g.stripBotMention('/exit@Hacctarr_bot', null), '/exit');
});

test('stripBotMention: everything else passes through untouched', () => {
  assert.equal(g.stripBotMention('/exit', 'Hacctarr_bot'), '/exit');
  assert.equal(g.stripBotMention('ping me@example.com about /exit', 'Hacctarr_bot'), 'ping me@example.com about /exit');
  assert.equal(g.stripBotMention('plain prose', 'Hacctarr_bot'), 'plain prose');
});

test('setToolPref: writes and clears at both scopes without disturbing the other', () => {
  const prefs = { chats: {}, threads: {} };
  g.setToolPref(prefs, { action: 'set', on: false, scope: 'chat' }, '-100', 7);
  g.setToolPref(prefs, { action: 'set', on: true, scope: 'thread' }, '-100', 7);
  assert.deepEqual(prefs, { chats: { '-100': false }, threads: { '-100_7': true } });
  g.setToolPref(prefs, { action: 'clear', scope: 'thread' }, '-100', 7);
  assert.deepEqual(prefs, { chats: { '-100': false }, threads: {} });
  g.setToolPref(prefs, { action: 'clear', scope: 'chat' }, '-100', 7);
  assert.deepEqual(prefs, { chats: {}, threads: {} });
});

// ---------------------------------------------------------------------------
// Tool-activity readout default
// ---------------------------------------------------------------------------
// One line per tool call turned a long desk session into hundreds of posts. Prose is what a phone
// reader actually wants, so the readout is opt-in now rather than opt-out.
test('SHOW_TOOL_ACTIVITY: off unless a config turns it on', () => {
  assert.equal(g.resolveShowTools({}), false, 'default is off');
  assert.equal(g.resolveShowTools({ SHOW_TOOL_ACTIVITY: true }), true, 'explicit opt-in');
  assert.equal(g.resolveShowTools({ SHOW_TOOL_ACTIVITY: false }), false);
  assert.equal(g.resolveShowTools(), false);
});

// ---------------------------------------------------------------------------
// Child MCP surface
// ---------------------------------------------------------------------------
// The tools array is the first thing in the cached prompt prefix, ahead of the system blocks and
// every message. A child that lets MCP servers connect asynchronously grows that array mid-run
// (measured: 29 tools -> 101 between two requests 15s apart), which invalidates the whole prefix
// and re-writes it at 1h TTL. Pinning the set is what keeps the prefix byte-stable across turns.
test('resolveChildMcp: no selection inherits the full surface (previous behavior)', () => {
  assert.deepEqual(g.resolveChildMcp(null, { a: { command: 'x' } }), { args: [], missing: [] });
  assert.deepEqual(g.resolveChildMcp(undefined, { a: { command: 'x' } }), { args: [], missing: [] });
});

test('resolveChildMcp: empty selection pins the child to zero MCP servers', () => {
  const { args } = g.resolveChildMcp([], { a: { command: 'x' } });
  assert.deepEqual(args, ['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config']);
});

test('resolveChildMcp: selection keeps only the named servers', () => {
  const pool = { a: { command: 'A' }, b: { command: 'B' }, c: { command: 'C' } };
  const { args } = g.resolveChildMcp(['a', 'c'], pool);
  assert.deepEqual(JSON.parse(args[1]), { mcpServers: { a: { command: 'A' }, c: { command: 'C' } } });
  assert.equal(args[2], '--strict-mcp-config');
});

test('resolveChildMcp: a name with no definition is reported, never silently dropped', () => {
  const { args, missing } = g.resolveChildMcp(['a', 'nope'], { a: { command: 'A' } });
  assert.deepEqual(missing, ['nope']);
  assert.deepEqual(JSON.parse(args[1]), { mcpServers: { a: { command: 'A' } } });
});

// The entire point of pinning is a byte-identical prefix on every turn. Object key order in the
// pool varies with however the config happened to be written, so serialization must sort.
test('resolveChildMcp: serialization is byte-stable regardless of pool key order', () => {
  const one = g.resolveChildMcp(['a', 'b'], { b: { command: 'B' }, a: { command: 'A' } }).args[1];
  const two = g.resolveChildMcp(['b', 'a'], { a: { command: 'A' }, b: { command: 'B' } }).args[1];
  assert.equal(one, two);
});

test('loadMcpServerPool: reads mcpServers, tolerates a missing or corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pool-'));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ mcpServers: { a: { command: 'A' } }, other: 1 }));
  assert.deepEqual(g.loadMcpServerPool(good), { a: { command: 'A' } });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.deepEqual(g.loadMcpServerPool(bad), {});
  assert.deepEqual(g.loadMcpServerPool(path.join(dir, 'absent.json')), {});
});

// ---------------------------------------------------------------------------
// parseTurnUsage / recordTurnUsage — token & cost telemetry from a turn's
// terminal stream-json `result` event (usage, total_cost_usd, modelUsage).
// ---------------------------------------------------------------------------
const { createTelemetry } = require('../telemetry');

test('parseTurnUsage normalizes tokens, cost and a single model', () => {
  const usage = g.parseTurnUsage({
    type: 'result', subtype: 'success', total_cost_usd: 0.437035,
    usage: {
      input_tokens: 2, output_tokens: 4,
      cache_creation_input_tokens: 42745, cache_read_input_tokens: 18950,
    },
    modelUsage: { 'claude-opus-5[1m]': { inputTokens: 2 } },
  });
  assert.strictEqual(usage.input_tokens, 2);
  assert.strictEqual(usage.output_tokens, 4);
  assert.strictEqual(usage.cache_creation_input_tokens, 42745);
  assert.strictEqual(usage.cache_read_input_tokens, 18950);
  assert.strictEqual(usage.cost_usd, 0.437035);
  assert.strictEqual(usage.model, 'claude-opus-5[1m]');
});

test('parseTurnUsage returns undefined when the event has no usage', () => {
  assert.strictEqual(g.parseTurnUsage({ type: 'result', subtype: 'success' }), undefined);
  assert.strictEqual(g.parseTurnUsage(null), undefined);
});

test('parseTurnUsage labels the model multi when a turn spanned several', () => {
  const usage = g.parseTurnUsage({
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-opus-5[1m]': {}, 'claude-haiku-4-5': {} },
  });
  assert.strictEqual(usage.model, 'multi');
});

test('recordTurnUsage fans usage out to bounded token and cost counters', () => {
  const tel = createTelemetry();
  g.recordTurnUsage(tel, 'documents', {
    input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 100, cache_read_input_tokens: 50,
    cost_usd: 0.25, model: 'claude-opus-5',
  });
  const snap = tel.snapshot();
  const tokens = snap.counters.filter((c) => c.name === 'gateway.tokens');
  assert.strictEqual(tokens.length, 4);
  const input = tokens.find((c) => c.attrs.type === 'input');
  assert.strictEqual(input.value, 10);
  assert.deepStrictEqual(input.attrs, { repo: 'documents', type: 'input', model: 'claude-opus-5' });
  const cost = snap.counters.find((c) => c.name === 'gateway.cost_usd');
  assert.strictEqual(cost.value, 0.25);
  assert.deepStrictEqual(cost.attrs, { repo: 'documents', model: 'claude-opus-5' });
});

test('recordTurnUsage is a no-op when usage is absent', () => {
  const tel = createTelemetry();
  g.recordTurnUsage(tel, 'documents', undefined);
  assert.strictEqual(tel.snapshot().counters.length, 0);
});
