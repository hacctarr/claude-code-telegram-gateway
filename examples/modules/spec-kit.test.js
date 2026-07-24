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
