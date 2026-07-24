'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const g = require('../gateway.js');

test('createModuleRegistry: emit calls the matching on<Hook> for each module', () => {
  const calls = [];
  const a = { name: 'a', hooks: { onTick(now) { calls.push(['a', now]); } } };
  const b = { name: 'b', hooks: { onTick(now) { calls.push(['b', now]); } } };
  const reg = g.createModuleRegistry([a, b], () => {});
  reg.emit('tick', 42);
  assert.deepEqual(calls, [['a', 42], ['b', 42]]);
});

test('createModuleRegistry: a hook that is absent is simply skipped', () => {
  const a = { name: 'a', hooks: {} };                       // no onTick
  const reg = g.createModuleRegistry([a], () => {});
  assert.doesNotThrow(() => reg.emit('tick', 1));
});

test('createModuleRegistry: a throwing hook is isolated and logged, others still run', () => {
  const logs = [];
  const bad = { name: 'bad', hooks: { onTick() { throw new Error('boom'); } } };
  const good = { name: 'good', hooks: { onTick() { logs.push('ran'); } } };
  const reg = g.createModuleRegistry([bad, good], (...a) => logs.push(a.join(' ')));
  assert.doesNotThrow(() => reg.emit('tick', 1));
  assert.ok(logs.includes('ran'));                          // good module still ran
  assert.ok(logs.some((l) => /bad/.test(l) && /boom/.test(l)));  // failure logged with module name
});

test('createModuleRegistry: names() lists module names; empty registry emit is a no-op', () => {
  const reg = g.createModuleRegistry([], () => {});
  assert.deepEqual(reg.names(), []);
  assert.doesNotThrow(() => reg.emit('transcriptLine', {}, {}));
});
