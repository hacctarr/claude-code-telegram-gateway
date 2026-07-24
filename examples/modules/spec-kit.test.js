'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('./spec-kit.js');

test('extractCommand: pulls the command name from a slash-command user record', () => {
  const rec = { type: 'user', message: { content: '<command-name>/implement</command-name><command-message>implement</command-message>' } };
  assert.equal(m.extractCommand(rec), '/implement');
});

test('extractCommand: array content is scanned too', () => {
  const rec = { type: 'user', message: { content: [{ type: 'text', text: '<command-name>/plan</command-name>' }] } };
  assert.equal(m.extractCommand(rec), '/plan');
});

test('extractCommand: plain user prose and non-user records return null', () => {
  assert.equal(m.extractCommand({ type: 'user', message: { content: 'just a normal message' } }), null);
  assert.equal(m.extractCommand({ type: 'assistant', message: { content: [] } }), null);
  assert.equal(m.extractCommand(null), null);
});

const CFG = { terminalCommand: '/implement', settleMs: 30000, reviewSettleMs: 90000 };
const base = () => ({ armedStep: null, armedAt: 0, firedSteps: [], reviewFired: false });

test('decideReaction: non-terminal step settles → compact', () => {
  const s = { ...base(), armedStep: '/plan', armedAt: 0 };
  const now = 100000, mtime = 100000 - 31000;   // idle 31s ≥ 30s
  assert.deepEqual(m.decideReaction(s, CFG, now, mtime), { action: 'compact', step: '/plan' });
});

test('decideReaction: not idle long enough → no action', () => {
  const s = { ...base(), armedStep: '/plan' };
  const now = 100000, mtime = 100000 - 10000;   // idle 10s < 30s
  assert.deepEqual(m.decideReaction(s, CFG, now, mtime), { action: null, step: null });
});

test('decideReaction: terminal step uses the longer review window', () => {
  const s = { ...base(), armedStep: '/implement' };
  const notYet = { now: 100000, mtime: 100000 - 60000 };   // 60s < 90s
  assert.equal(m.decideReaction(s, CFG, notYet.now, notYet.mtime).action, null);
  const go = { now: 100000, mtime: 100000 - 91000 };       // 91s ≥ 90s
  assert.deepEqual(m.decideReaction(s, CFG, go.now, go.mtime), { action: 'review', step: '/implement' });
});

test('decideReaction: an already-fired step does not re-fire', () => {
  const s = { ...base(), armedStep: '/plan', firedSteps: ['/plan'] };
  assert.equal(m.decideReaction(s, CFG, 100000, 0).action, null);
});

test('decideReaction: review does not re-fire once reviewFired', () => {
  const s = { ...base(), armedStep: '/implement', reviewFired: true };
  assert.equal(m.decideReaction(s, CFG, 100000, 0).action, null);
});

// A fake api that records calls and holds state in memory.
function fakeApi(overrides = {}) {
  const store = {};
  const calls = { inject: [], spawn: [], post: [] };
  return {
    calls,
    _store: store,
    injectTurn: (sid, p) => calls.inject.push([sid, p]),
    spawnSession: (o) => { calls.spawn.push(o); return 'new-review-id'; },
    postToTopic: (sid, t) => calls.post.push([sid, t]),
    getSessionInfo: (sid) => overrides.info || { cwd: '/repo', chatId: '1', threadId: 2, mtime: 0 },
    state: () => ({ data: store, save() {} }),
    config: overrides.config || {},
    log() {},
  };
}

test('spec-kit: /plan arms the session, then a settled tick compacts once', () => {
  const api = fakeApi({ info: { cwd: '/repo', mtime: 0 } });
  const mod = require('./spec-kit.js')(api);
  mod.onTranscriptLine({ sessionId: 'S', cwd: '/repo', chatId: '1', threadId: 2 },
    { type: 'user', message: { content: '<command-name>/plan</command-name>' } });
  mod.onTick(9_999_999);                             // now ≫ settle; mtime 0 → very idle
  assert.deepEqual(api.calls.inject, [['S', '/compact']]);
  assert.equal(api.calls.post.length, 1);
  assert.match(api.calls.post[0][1], /plan/);
  mod.onTick(9_999_999);                             // second tick must NOT re-fire
  assert.equal(api.calls.inject.length, 1);
});

test('spec-kit: /implement spawns exactly one review session', () => {
  const api = fakeApi({ info: { cwd: '/repo', mtime: 0 } });
  const mod = require('./spec-kit.js')(api);
  mod.onTranscriptLine({ sessionId: 'S', cwd: '/repo' },
    { type: 'user', message: { content: '<command-name>/implement</command-name>' } });
  mod.onTick(9_999_999);
  assert.equal(api.calls.spawn.length, 1);
  assert.equal(api.calls.spawn[0].cwd, '/repo');
  assert.equal(api.calls.spawn[0].prompt, '/code-review');
  mod.onTick(9_999_999);
  assert.equal(api.calls.spawn.length, 1);           // reviewFired dedup
});

test('spec-kit: /compact and /code-review never arm a step', () => {
  const api = fakeApi();
  const mod = require('./spec-kit.js')(api);
  mod.onTranscriptLine({ sessionId: 'S' }, { type: 'user', message: { content: '<command-name>/compact</command-name>' } });
  mod.onTick(9_999_999);
  assert.equal(api.calls.inject.length, 0);
  assert.equal(api.calls.spawn.length, 0);
});
