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

const fs = require('fs');
const path = require('path');
const os = require('os');

test('resolveModulePath: absolute, ~, and bare-name forms', () => {
  assert.equal(g.resolveModulePath('/abs/mod.js', '/gw'), '/abs/mod.js');
  assert.equal(g.resolveModulePath('~/m.js', '/gw'), path.join(process.env.HOME, 'm.js'));
  assert.equal(g.resolveModulePath('mods/x.js', '/gw'), path.join('/gw', 'mods/x.js'));
});

test('loadModules: requires each module file and instantiates its factory with api', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mod-'));
  const file = path.join(dir, 'echo.js');
  fs.writeFileSync(file, `module.exports = (api) => ({ name: 'echo', onTick(n){ api.log('tick', n); } });`);
  const logs = [];
  const api = { log: (...a) => logs.push(a.join(' ')) };
  const reg = g.loadModules({ MODULES: [file] }, api, () => {});
  assert.deepEqual(reg.names(), ['echo']);
  reg.emit('tick', 7);
  assert.ok(logs.includes('tick 7'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadModules: a module that throws at load is skipped, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mod-'));
  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(bad, `throw new Error('load boom');`);
  const errs = [];
  const reg = g.loadModules({ MODULES: [bad] }, {}, (...a) => errs.push(a.join(' ')));
  assert.deepEqual(reg.names(), []);
  assert.ok(errs.some((e) => /bad/.test(e) && /load boom/.test(e)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadModules: empty/absent MODULES yields a no-op registry', () => {
  assert.deepEqual(g.loadModules({}, {}, () => {}).names(), []);
  assert.deepEqual(g.loadModules({ MODULES: [] }, {}, () => {}).names(), []);
});
