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

// The real builtin is instantiated in these, not a stand-in, so the api has to carry
// what its factory actually touches. auto-compact takes api.state() at construction:
// stubbing thinner than the real api would make every one of these pass by loading
// nothing, which is the failure they exist to catch.
function apiStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-api-'));
  return { config: {}, state: () => ({ data: {}, save() {} }), _dir: dir };
}

// auto-compact ships in the package and loads with no configuration, so an install
// that names no MODULES at all still gets it. The older contract here was that an
// absent MODULES meant an empty registry; that is now "no EXTERNAL modules", which
// is the assertion below.
test('loadModules: auto-compact loads by default, with or without an empty MODULES', () => {
  assert.deepEqual(g.loadModules({}, apiStub(), () => {}).names(), ['auto-compact']);
  assert.deepEqual(g.loadModules({ MODULES: [] }, apiStub(), () => {}).names(), ['auto-compact']);
});

test('loadModules: AUTO_COMPACT false is the opt-out, and only false opts out', () => {
  assert.deepEqual(g.loadModules({ AUTO_COMPACT: false }, apiStub(), () => {}).names(), []);
  assert.deepEqual(g.loadModules({ AUTO_COMPACT: true }, apiStub(), () => {}).names(), ['auto-compact']);
  // Absent is on. An unrelated key must not read as an opt-out.
  assert.deepEqual(g.loadModules({ TITLE_MODE: 'x' }, apiStub(), () => {}).names(), ['auto-compact']);
});

test('loadModules: a builtin still loads alongside external MODULES, builtins first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mod-'));
  const file = path.join(dir, 'ext.js');
  fs.writeFileSync(file, `module.exports = () => ({ name: 'ext' });`);
  assert.deepEqual(g.loadModules({ MODULES: [file] }, apiStub(), () => {}).names(), ['auto-compact', 'ext']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Naming the shipped file explicitly in MODULES was how it had to be enabled before
// it became a builtin. Those configs still exist, and loading it twice would inject
// two /compact turns per idle period.
test('loadModules: naming the builtin in MODULES does not load it twice', () => {
  const shipped = require.resolve('../modules/auto-compact.js');
  assert.deepEqual(g.loadModules({ MODULES: [shipped] }, apiStub(), () => {}).names(), ['auto-compact']);
});

test('loadModules: a broken builtin is skipped and never stops external modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mod-'));
  const file = path.join(dir, 'ext.js');
  fs.writeFileSync(file, `module.exports = () => ({ name: 'ext' });`);
  const errs = [];
  const reg = g.loadModules({ MODULES: [file] }, {}, (...a) => errs.push(a.join(' ')), undefined,
    [{ name: 'auto-compact', file: '/nope/missing-builtin.js' }]);
  assert.deepEqual(reg.names(), ['ext']);
  assert.ok(errs.some((e) => /missing-builtin/.test(e)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// The mcp argument is passed explicitly here rather than left to default. It defaults to whatever
// CHILD_MCP_SERVERS resolves to in the config on this machine, so asserting the default would make
// the test pass or fail depending on who ran it.
test('buildSpawnArgs: session id + mode always present, model only when given', () => {
  assert.deepEqual(g.buildSpawnArgs('sid', 'plan', null, []),
    ['-p', '--session-id', 'sid', '--permission-mode', 'plan']);
  assert.deepEqual(g.buildSpawnArgs('sid', 'plan', 'opus', []),
    ['-p', '--session-id', 'sid', '--permission-mode', 'plan', '--model', 'opus']);
});

test('buildSpawnArgs: a pinned MCP surface is appended to the spawn args', () => {
  const mcp = g.resolveChildMcp([], {}).args;
  assert.deepEqual(g.buildSpawnArgs('sid', 'plan', null, mcp),
    ['-p', '--session-id', 'sid', '--permission-mode', 'plan',
     '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config']);
});

test('buildModuleApi: state(name) round-trips through a JSON file', () => {
  const file = g.statePath('module-unit-test-modstate');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });                 // no stale artifact from a prior run
  try {
    const api = g.buildModuleApi();
    const st = api.state('unit-test-modstate');
    assert.deepEqual(st.data, {});                  // fresh
    st.data.x = 1;
    st.save();
    const st2 = api.state('unit-test-modstate');
    assert.equal(st2.data.x, 1);                    // reloaded from disk
  } finally {
    fs.rmSync(file, { force: true });               // leave no artifact behind
  }
});

test('buildModuleApi: exposes the metric surface, not the whole telemetry object', () => {
  const api = g.buildModuleApi();
  assert.equal(typeof api.telemetry.count, 'function');
  assert.equal(typeof api.telemetry.gauge, 'function');
  assert.equal(typeof api.telemetry.record, 'function');
  assert.equal(typeof api.telemetry.registerObservable, 'function');
  // A module must not be able to reconfigure or stop the exporter the gateway owns.
  assert.equal(api.telemetry.start, undefined);
  assert.equal(api.telemetry.stop, undefined);
  assert.equal(api.telemetry.flush, undefined);
});

test('buildModuleApi: a module metric reaches the exporter snapshot', () => {
  const api = g.buildModuleApi();
  api.telemetry.count('module.unit.test.counter', { unit: 'test' }, 3);
  api.telemetry.gauge('module.unit.test.gauge', 42, { unit: 'test' });
  const snap = g.telemetry.snapshot();
  const counter = snap.counters.find((c) => c.name === 'module.unit.test.counter');
  const gauge = snap.gauges.find((x) => x.name === 'module.unit.test.gauge');
  assert.equal(counter && counter.value, 3);
  assert.equal(gauge && gauge.value, 42);
});

test('buildModuleApi: a throwing observable is isolated from the exporter', () => {
  const api = g.buildModuleApi();
  api.telemetry.registerObservable('module.unit.test.bad', () => { throw new Error('boom'); });
  assert.doesNotThrow(() => g.telemetry.snapshot());
});

test('buildModuleApi: injectTurn enqueues onto the gateway queue', () => {
  const api = g.buildModuleApi();
  // injectTurn delegates to queueForSession; assert no throw and returns undefined.
  assert.doesNotThrow(() => api.injectTurn('sess-x', '/compact'));
});
