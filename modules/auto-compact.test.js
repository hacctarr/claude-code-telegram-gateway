'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('./auto-compact.js');
const { decideCompaction } = mod;

const CFG = { idleMs: 45 * 60000, minTokens: 120000, prelude: null, instructions: 'keep decisions' };
const MIN = 60000;

// A session that has gone quiet with a big context is the whole point of the module.
test('decideCompaction: idle past the window with a large context fires', () => {
  const now = 10 * 60 * MIN;
  const d = decideCompaction({}, CFG, now, now - 50 * MIN, 200000);
  assert.equal(d.fire, true);
});

test('decideCompaction: still active inside the idle window does not fire', () => {
  const now = 10 * 60 * MIN;
  const d = decideCompaction({}, CFG, now, now - 5 * MIN, 200000);
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'active');
});

// The floor is what keeps the module from spending a summarization call on a short topic,
// and it is also what stops a just-compacted session from looping.
test('decideCompaction: a context under the floor does not fire, however idle', () => {
  const now = 10 * 60 * MIN;
  const d = decideCompaction({}, CFG, now, now - 300 * MIN, 5300);
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'below-floor');
});

test('decideCompaction: does not fire twice for the same quiet period', () => {
  const now = 10 * 60 * MIN;
  const mtime = now - 50 * MIN;
  const first = decideCompaction({}, CFG, now, mtime, 200000);
  assert.equal(first.fire, true);
  const after = decideCompaction({ firedAtMtime: mtime }, CFG, now + MIN, mtime, 200000);
  assert.equal(after.fire, false);
  assert.equal(after.reason, 'already-fired');
});

// New work after a compaction moves mtime, which re-arms the session for its next quiet period.
test('decideCompaction: new activity after a fire re-arms the session', () => {
  const now = 10 * 60 * MIN;
  const firedAt = now - 200 * MIN;
  const d = decideCompaction({ firedAtMtime: firedAt }, CFG, now, now - 50 * MIN, 200000);
  assert.equal(d.fire, true);
});

test('decideCompaction: an unknown mtime is treated as active, never as infinitely idle', () => {
  const d = decideCompaction({}, CFG, 10 * 60 * MIN, 0, 200000);
  assert.equal(d.fire, false);
  assert.equal(d.reason, 'active');
});

// ---------------------------------------------------------------------------
// The prompts the module injects
// ---------------------------------------------------------------------------
test('compactPrompts: instructions ride along on the /compact turn', () => {
  const p = mod.compactPrompts({ prelude: null, instructions: 'keep the permit numbers' });
  assert.deepEqual(p, ['/compact keep the permit numbers']);
});

test('compactPrompts: a prelude is injected as its own turn, ahead of the compaction', () => {
  const p = mod.compactPrompts({ prelude: '/remember', instructions: 'keep decisions' });
  assert.deepEqual(p, ['/remember', '/compact keep decisions']);
});

test('compactPrompts: with no instructions the turn is a bare /compact', () => {
  assert.deepEqual(mod.compactPrompts({ prelude: null, instructions: '' }), ['/compact']);
});

// ---------------------------------------------------------------------------
// The module against a fake api
// ---------------------------------------------------------------------------
function fakeApi(overrides = {}) {
  const calls = { injected: [], posted: [] };
  const store = { data: {}, save() { calls.saved = true; } };
  return {
    calls,
    api: {
      config: overrides.config || {},
      state: () => store,
      log: () => {},
      injectTurn: (sid, prompt) => calls.injected.push([sid, prompt]),
      postToTopic: (sid, text) => calls.posted.push([sid, text]),
      getSessionInfo: overrides.getSessionInfo || (() => ({ cwd: '/repo', mtime: 0 })),
      getContextTokens: overrides.getContextTokens || (() => 0),
      isSessionHeld: overrides.isSessionHeld || (() => false),
    },
  };
}

test('module: an idle over-floor session gets prelude then /compact, and a topic notice', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    config: { AUTO_COMPACT_PRELUDE: '/remember', AUTO_COMPACT_INSTRUCTIONS: 'keep decisions' },
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's1' }, { type: 'assistant' });
  m.onTick(now);
  assert.deepEqual(calls.injected, [['s1', '/remember'], ['s1', '/compact keep decisions']]);
  assert.equal(calls.posted.length, 1);
  assert.match(calls.posted[0][1], /200k/);
});

test('module: a busy session is left alone', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - MIN }),
    getContextTokens: () => 200000,
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's1' }, { type: 'assistant' });
  m.onTick(now);
  assert.deepEqual(calls.injected, []);
});

// A phone-driven turn never reaches onTranscriptLine, so the module would otherwise
// never learn that the session exists.
test('module: a texted-in turn registers the session too', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
  });
  const m = mod(api);
  m.onInjectedTurn({ sessionId: 's2' }, 'do the thing');
  m.onTick(now);
  assert.equal(calls.injected.length, 1);
  assert.equal(calls.injected[0][0], 's2');
});

// Arming on a compaction turn would queue a compaction of the compaction. Holds for a
// hand-texted /compact too, not just the wording this module happens to inject.
test('module: a compaction turn does not re-register the session', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
  });
  const m = mod(api);
  m.onInjectedTurn({ sessionId: 's3' }, '/compact keep decisions');
  m.onTick(now);
  assert.deepEqual(calls.injected, []);
});

test('module: a session the gateway no longer knows is dropped from state', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({ getSessionInfo: () => null, getContextTokens: () => 200000 });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 'gone' }, { type: 'assistant' });
  m.onTick(now);
  assert.deepEqual(calls.injected, []);
});

test('module: config overrides the idle window and the floor', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    config: { AUTO_COMPACT_IDLE_MINUTES: 5, AUTO_COMPACT_MIN_TOKENS: 1000 },
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 6 * MIN }),
    getContextTokens: () => 2000,
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's4' }, { type: 'assistant' });
  m.onTick(now);
  assert.equal(calls.injected.length, 1);
});

// ---------------------------------------------------------------------------
// An open desk session
//
// A desk TUI holds its context in memory. A /compact injected from outside cannot
// shrink it: the gateway sees the session as held and forks, so the compaction lands
// on a throwaway branch that also takes the topic with it, and the desk stays exactly
// as large as it was. Twenty minutes later the same session is still idle and still
// over the floor, so it happens again. Eighteen times in 35 hours on this machine
// before the accessor existed to notice.
// ---------------------------------------------------------------------------
test('module: an idle over-floor session whose desk is still open is not compacted', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
    isSessionHeld: () => true,
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's1' }, { type: 'assistant' });
  m.onTick(now);
  assert.deepEqual(calls.injected, []);
});

// The quiet period has to survive the skip. A desk left open overnight does not move
// mtime, so consuming the period on the skip would mean the session is never compacted
// at all once it finally closes.
test('module: a skipped session still compacts once the desk closes, same quiet period', () => {
  const now = 10 * 60 * MIN;
  const mtime = now - 50 * MIN;
  let open = true;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime }),
    getContextTokens: () => 200000,
    isSessionHeld: () => open,
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's1' }, { type: 'assistant' });
  m.onTick(now);
  assert.deepEqual(calls.injected, []);
  open = false;
  m.onTick(now + MIN);
  assert.deepEqual(calls.injected, [['s1', '/compact ' +
    'Preserve decisions, their rationale, open questions, and any identifiers ' +
    '(paths, ticket ids, account or permit numbers). Drop file listings and tool output.']]);
});

// The machine runs many sessions at once and only some have a desk attached, so a
// per-tick answer would suppress or fire the wrong ones.
test('module: the held check is per session, so an open desk does not shield a closed one', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
    isSessionHeld: (sid) => sid === 'desk-open',
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 'desk-open' }, { type: 'assistant' });
  m.onTranscriptLine({ sessionId: 'desk-closed' }, { type: 'assistant' });
  m.onTick(now);
  assert.deepEqual(calls.injected.map((c) => c[0]), ['desk-closed']);
});

// Silence here is how the previous failure hid: the compaction the user was told to
// expect simply never happened. One notice per quiet period says so without turning
// into a message every tick for as long as the desk stays open.
test('module: the desk-open notice posts once per quiet period, not every tick', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
    isSessionHeld: () => true,
  });
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's1' }, { type: 'assistant' });
  m.onTick(now);
  m.onTick(now + MIN);
  m.onTick(now + 2 * MIN);
  assert.equal(calls.posted.length, 1);
  assert.match(calls.posted[0][1], /desk/i);
  assert.match(calls.posted[0][1], /200k/);
});

test('module: a gateway without getContextTokens stays inert rather than throwing', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({ getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }) });
  delete api.getContextTokens;
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's5' }, { type: 'assistant' });
  assert.doesNotThrow(() => m.onTick(now));
  assert.deepEqual(calls.injected, []);
});

// This module is built in, so it and the accessor ship as one unit and the absence can
// only mean a copy running against a foreign api. Compacting is the behavior that was
// asked for; going inert would disable the feature with nothing to say why.
test('module: an api with no isSessionHeld still compacts rather than going inert', () => {
  const now = 10 * 60 * MIN;
  const { api, calls } = fakeApi({
    getSessionInfo: () => ({ cwd: '/repo', mtime: now - 50 * MIN }),
    getContextTokens: () => 200000,
  });
  delete api.isSessionHeld;
  const m = mod(api);
  m.onTranscriptLine({ sessionId: 's6' }, { type: 'assistant' });
  m.onTick(now);
  assert.equal(calls.injected.length, 1);
});
