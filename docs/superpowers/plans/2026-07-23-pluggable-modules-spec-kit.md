# Pluggable Gateway Modules + spec-kit Workflow Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `gateway.js` a small generic in-package module system, and ship the first module (external `spec-kit.js`) that compacts a spec-kit session between steps and spawns a fresh `/code-review` session when `/implement` completes.

**Architecture:** A registry loads external module files named in `config.MODULES`, instantiates each with a curated `api`, and `emit()`s three lifecycle hooks (`transcriptLine`, `tick`) from `pollTick`, each call wrapped in per-module try/catch. Modules never touch gateway internals — only the `api` (inject a turn, spawn a detached session, post to a topic, read session info, persist namespaced state, log, read config). The spec-kit module is an external file (lives under `examples/modules/`, excluded from the npm tarball) that arms on spec-kit slash commands and reacts on settle windows.

**Tech Stack:** Node.js (nvm v26.2.0), CommonJS, zero new dependencies. Tests via `node --test`, pure-function-export style matching `test/gateway.test.js`.

## Global Constraints

- **No new dependencies.** Node built-ins only (`fs`, `path`, `crypto`, `child_process`, `os`).
- **CommonJS.** `require`/`module.exports`, matching `gateway.js`.
- **Boot guard.** All top-level behavior stays behind the existing `require.main === module` guard so `require('../gateway.js')` in tests never boots the gateway.
- **OSS no-op guarantee.** Absent or empty `config.MODULES` ⇒ the module system is a pure no-op; existing installs behave exactly as before.
- **Isolation is load-bearing.** Every hook dispatch is wrapped in per-module try/catch; a throwing module is logged and skipped, never crashing `pollTick` or affecting other modules.
- **Package exclusion.** The spec-kit module and its test live under `examples/modules/` and must NOT appear in `package.json`'s `files` whitelist — that keeps them out of the published `claude-code-telegram-gateway` tarball.
- **Restart discipline.** Reload after code changes with `touch <install-dir>/restart.flag`. Never `launchctl kickstart -k` from a gateway-driven turn.
- **Audit-line style.** Module status posts match the existing emoji-prefixed convention (`✅`, `🔍`) used throughout `gateway.js`.
- **Test command:** `node --test test/*.test.js examples/modules/*.test.js` (set in Task 8).

**Spec:** `docs/superpowers/specs/2026-07-23-pluggable-modules-spec-kit-design.md`

---

## File Structure

**Created:**
- `test/modules.test.js` — unit tests for the in-package module system (ships with package; tests generic machinery).
- `examples/modules/spec-kit.js` — the spec-kit module (excluded from tarball).
- `examples/modules/spec-kit.test.js` — spec-kit module tests (excluded from tarball).
- `examples/modules/README.md` — how to install an external module.

**Modified:**
- `gateway.js` — add the registry, `api` builder, `spawnSession`, two `emit` dispatch points in `pollTick`, the `loadModules()` boot call, and new exports.
- `config.example.json` — add a documented `MODULES` key.
- `package.json` — extend the `test` script to also run `examples/modules/*.test.js`.
- `README.md` — a "Modules" section pointing at `examples/modules/`.

---

## Task 1: Module registry (dispatch + isolation)

Pure registry that holds instantiated modules and dispatches hooks with per-module error isolation. No filesystem, no `require` — those come in Task 2.

**Files:**
- Modify: `gateway.js` (add `createModuleRegistry` near the queue helpers, ~line 1011, after `queueForSession`)
- Modify: `gateway.js` `module.exports` (line 1611-1620)
- Test: `test/modules.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createModuleRegistry(instances, log)` → `{ emit(hook, ...args), names() }`
    - `instances`: array of `{ name: string, hooks: object }`.
    - `emit('transcriptLine'|'tick'|..., ...args)`: for each instance whose `hooks['on'+Capitalized(hook)]` is a function, calls it with `...args` inside try/catch; a throw is passed to `log(...)` and skipped.
    - `names()`: array of module names.
    - Hook name mapping: `emit('transcriptLine', ...)` calls `hooks.onTranscriptLine(...)`; `emit('tick', ...)` calls `hooks.onTick(...)`.

- [ ] **Step 1: Write the failing test**

Add to `test/modules.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modules.test.js`
Expected: FAIL — `g.createModuleRegistry is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `gateway.js`, immediately after `queueForSession` (line 1011):

```js
// ---------------------------------------------------------------------------
// Module system: external files named in config.MODULES extend the gateway
// against a curated api. Empty/absent MODULES → pure no-op (OSS-safety).
// ---------------------------------------------------------------------------
// A registry over already-instantiated modules ({ name, hooks }). emit() maps a
// hook key to on<Hook> and calls it per module inside try/catch, so one module's
// bug can never crash pollTick or affect another module/install.
function createModuleRegistry(instances, log = console.error) {
  const list = Array.isArray(instances) ? instances : [];
  const method = (hook) => 'on' + hook.charAt(0).toUpperCase() + hook.slice(1);
  return {
    emit(hook, ...args) {
      const fn = method(hook);
      for (const m of list) {
        const h = m.hooks && m.hooks[fn];
        if (typeof h !== 'function') continue;
        try { h(...args); }
        catch (e) { log(`[Module ${m.name}] ${fn} threw: ${e.message}`); }
      }
    },
    names() { return list.map((m) => m.name); },
  };
}
```

Add `createModuleRegistry` to the `module.exports` object (line 1611-1620).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modules.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add gateway.js test/modules.test.js
git commit -m "feat(modules): module registry with per-module hook isolation"
```

---

## Task 2: Module loading (path resolution + require)

Resolve the `config.MODULES` path list and instantiate each module file by requiring it and calling its factory with `api`. A module that fails to load is logged and skipped — never fatal.

**Files:**
- Modify: `gateway.js` (add `resolveModulePath` + `loadModules` right after `createModuleRegistry`)
- Modify: `gateway.js` `module.exports`
- Test: `test/modules.test.js`

**Interfaces:**
- Consumes: `createModuleRegistry` (Task 1), `STATE_DIR` (line 15), `resolveHome` (line 242).
- Produces:
  - `resolveModulePath(entry, gatewayDir)` → absolute path string. Handles `~/…` (via `resolveHome`), already-absolute paths (unchanged), and bare/relative names (joined onto `gatewayDir`).
  - `loadModules(config, api, log)` → registry from `createModuleRegistry`. For each `config.MODULES` entry: resolve path, `require()` it, call the exported factory with `api`, collect `{ name: hooks.name || <basename>, hooks }`. A require/factory throw is logged and that module skipped. Empty/absent `MODULES` ⇒ registry over `[]`.

- [ ] **Step 1: Write the failing test**

Add to `test/modules.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modules.test.js`
Expected: FAIL — `g.resolveModulePath is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `gateway.js`, after `createModuleRegistry`:

```js
// Resolve a MODULES entry to an absolute path: ~ expands, absolute passes through,
// anything else is relative to the gateway state dir (default ~/.claude-gateway).
function resolveModulePath(entry, gatewayDir) {
  const p = resolveHome(entry);
  return path.isAbsolute(p) ? p : path.join(gatewayDir, p);
}

// Require each module file and instantiate its factory with the curated api.
// A module that fails to load is logged and skipped — one bad module never
// stops the gateway or the others.
function loadModules(config, api, log = console.error, gatewayDir = STATE_DIR) {
  const entries = Array.isArray(config && config.MODULES) ? config.MODULES : [];
  const instances = [];
  for (const entry of entries) {
    const file = resolveModulePath(entry, gatewayDir);
    try {
      const factory = require(file);
      if (typeof factory !== 'function') throw new Error('module does not export a factory function');
      const hooks = factory(api);
      instances.push({ name: (hooks && hooks.name) || path.basename(file, '.js'), hooks: hooks || {} });
      log(`[Module] loaded ${(hooks && hooks.name) || path.basename(file, '.js')} from ${file}`);
    } catch (e) {
      log(`[Module] failed to load ${file}: ${e.message}`);
    }
  }
  return createModuleRegistry(instances, log);
}
```

Add `resolveModulePath` and `loadModules` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modules.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add gateway.js test/modules.test.js
git commit -m "feat(modules): load external module files named in config.MODULES"
```

---

## Task 3: The api object + spawnSession helper

Build the curated `api` modules receive, and the one genuinely new primitive: a detached, fire-and-forget `claude -p` session.

**Files:**
- Modify: `gateway.js` (add `buildSpawnArgs`, `spawnSession`, `buildModuleApi` after `loadModules`)
- Modify: `gateway.js` `module.exports`
- Test: `test/modules.test.js`

**Interfaces:**
- Consumes: `queueForSession` (1008), `sendPlain` (384), `readSessionInfo` (291) / `linkBySession` (143), `sessionFileById` (284), `statePath` (47), `CLAUDE_BINARY` (76), `PERM_MODE` (77), `MODEL` (73), `crypto`.
- Produces:
  - `buildSpawnArgs(sessionId, mode, model)` → string[]. Always `['-p', '--session-id', sessionId, '--permission-mode', mode]`; appends `['--model', model]` when `model` is truthy. **Pure.**
  - `spawnSession({ cwd, prompt, mode })` → minted `sessionId` (uuid). Spawns detached `claude`, writes `prompt` to stdin, `unref()`s, returns immediately. `mode` defaults to `PERM_MODE`.
  - `buildModuleApi({ injecting })` → the `api` object:
    - `injectTurn(sessionId, prompt)` → `queueForSession(sessionId, prompt)`
    - `spawnSession({cwd, prompt, mode})` → `spawnSession(...)`
    - `postToTopic(sessionId, text)` → looks up `linkBySession[sessionId]`, calls `sendPlain(l.chatId, l.threadId, text)`; no-op if unlinked
    - `getSessionInfo(sessionId)` → `{ cwd, chatId, threadId, label, mtime }` or `null`
    - `state(name)` → `{ data, save() }` persisted as JSON at `statePath('module-' + name)`
    - `config` → the gateway `config` object (read-only use by modules)
    - `log(...args)` → `console.log('[Module]', ...args)`

- [ ] **Step 1: Write the failing test**

Add to `test/modules.test.js`:

```js
test('buildSpawnArgs: session id + mode always present, model only when given', () => {
  assert.deepEqual(g.buildSpawnArgs('sid', 'plan'),
    ['-p', '--session-id', 'sid', '--permission-mode', 'plan']);
  assert.deepEqual(g.buildSpawnArgs('sid', 'plan', 'opus'),
    ['-p', '--session-id', 'sid', '--permission-mode', 'plan', '--model', 'opus']);
});

test('buildModuleApi: state(name) round-trips through a JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-state-'));
  const prev = process.env.CLAUDE_GATEWAY_DIR;
  // statePath writes under STATE_DIR captured at module load; test the persistence shape directly.
  const api = g.buildModuleApi({ injecting: new Set() });
  const st = api.state('unit-test-modstate');
  assert.deepEqual(st.data, {});           // fresh
  st.data.x = 1;
  st.save();
  const st2 = api.state('unit-test-modstate');
  assert.equal(st2.data.x, 1);             // reloaded from disk
  fs.rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.CLAUDE_GATEWAY_DIR; else process.env.CLAUDE_GATEWAY_DIR = prev;
});

test('buildModuleApi: injectTurn enqueues onto the gateway queue', () => {
  const api = g.buildModuleApi({ injecting: new Set() });
  // injectTurn delegates to queueForSession; assert no throw and returns undefined.
  assert.doesNotThrow(() => api.injectTurn('sess-x', '/compact'));
});
```

Note: `state()` persists under the real `STATE_DIR`; the test uses a uniquely-named state key and cleans it up.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modules.test.js`
Expected: FAIL — `g.buildSpawnArgs is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `gateway.js`, after `loadModules`:

```js
// Args for a detached review/aux session. Pure so it can be unit-tested.
function buildSpawnArgs(sessionId, mode, model) {
  const args = ['-p', '--session-id', sessionId, '--permission-mode', mode];
  if (model) args.push('--model', model);
  return args;
}

// Fire-and-forget headless session. Unlike runClaudeTurn (live-streamed, driven,
// permission-plumbed), this mints a uuid, spawns detached, feeds the prompt on
// stdin, and returns the id without waiting. The poll loop then discovers the new
// .jsonl, creates a topic, and mirrors it like any other session.
function spawnSession({ cwd, prompt, mode }) {
  const sessionId = crypto.randomUUID();
  const args = buildSpawnArgs(sessionId, mode || PERM_MODE, MODEL);
  try {
    const child = spawn(CLAUDE_BINARY, args, { cwd, env: { ...process.env }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', (e) => console.error('[Module] spawnSession failed:', e.message));
    try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { /* child gone */ }
    child.unref();
    console.log(`[Module] spawned session ${sessionId.slice(0, 8)} in ${cwd}`);
  } catch (e) {
    console.error('[Module] spawnSession error:', e.message);
  }
  return sessionId;
}

// The curated surface modules receive. Everything is a thin wrapper over an existing
// gateway function — modules never reach into internals.
function buildModuleApi({ injecting }) {
  return {
    injectTurn(sessionId, prompt) { return queueForSession(sessionId, prompt); },
    spawnSession(opts) { return spawnSession(opts); },
    postToTopic(sessionId, text) {
      const l = linkBySession[sessionId];
      if (!l) return false;
      return sendPlain(l.chatId, l.threadId, text);
    },
    getSessionInfo(sessionId) {
      const l = linkBySession[sessionId];
      const file = sessionFileById(sessionId);
      let cwd = null, mtime = 0;
      if (file) { cwd = cwdCache.get(file) || null; try { mtime = fs.statSync(file).mtimeMs; } catch (e) { /* */ } }
      if (!l && !file) return null;
      return { cwd, chatId: l && l.chatId, threadId: l && l.threadId, label: l && l.label, mtime };
    },
    state(name) {
      const file = statePath('module-' + name);
      let data = {};
      try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = {}; }
      return { data, save() { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('[Module] state save failed:', e.message); } } };
    },
    config,
    log(...a) { console.log('[Module]', ...a); },
  };
}
```

Add `buildSpawnArgs`, `spawnSession`, `buildModuleApi` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modules.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add gateway.js test/modules.test.js
git commit -m "feat(modules): curated api + detached spawnSession primitive"
```

---

## Task 4: Wire dispatch points into pollTick + boot

Connect the registry to the running gateway: emit `transcriptLine` per mirrored record, `tick` once per poll, and load modules at boot. A default no-op registry means nothing changes until a module is configured.

**Files:**
- Modify: `gateway.js` (module-registry global near line 1264; two `emit` calls in `pollTick`; `loadModules` in `main()` at 1594)
- Test: manual (integration) — the emit seam is already unit-tested via Task 1; this task is wiring.

**Interfaces:**
- Consumes: `loadModules` (Task 2), `buildModuleApi` (Task 3), `createModuleRegistry` (Task 1).
- Produces: a module-level `moduleRegistry` with `.emit(...)`, defaulting to a no-op registry.

- [ ] **Step 1: Add the default no-op registry global**

In `gateway.js`, just before `let polling = false;` (line 1264):

```js
// Loaded at boot from config.MODULES; a no-op registry until then so the mirror
// loop can call moduleRegistry.emit() unconditionally with zero overhead.
let moduleRegistry = createModuleRegistry([], console.error);
```

- [ ] **Step 2: Add the transcriptLine dispatch inside the mirror block**

In `pollTick`, immediately after `const { lines, newOffset } = readNewLines(file, link.offset);` (line 1309), before `const posts = [];`:

```js
        // Feed each new record to modules (spec-kit arming, etc.). ctx carries the
        // session's identity so a module needs no gateway internals.
        const modCtx = { sessionId: id, cwd, chatId: link.chatId, threadId: link.threadId };
        for (const o of lines) moduleRegistry.emit('transcriptLine', modCtx, o);
```

- [ ] **Step 3: Add the tick dispatch once per poll**

In `pollTick`, after the queue-flush loop (after line 1371, before the `} catch (err) {` at 1372):

```js
    // Per-tick module hook: settle-window timers, deferred reactions.
    moduleRegistry.emit('tick', now);
```

- [ ] **Step 4: Load modules at boot**

In the `if (require.main === module)` block, immediately after `loadSuperseded();` (line 1596):

```js
  moduleRegistry = loadModules(config, buildModuleApi({ injecting }), console.error);
  if (moduleRegistry.names().length) console.log(`Modules: ${moduleRegistry.names().join(', ')}`);
```

- [ ] **Step 5: Verify the full suite still passes and gateway still loads**

Run: `node --test test/*.test.js`
Expected: PASS (existing gateway.test.js + modules.test.js all green).

Run: `node -e "require('./gateway.js'); console.log('require OK — no boot')"`
Expected: prints `require OK — no boot` (boot guard holds; no Telegram calls).

- [ ] **Step 6: Commit**

```bash
git add gateway.js
git commit -m "feat(modules): dispatch transcriptLine/tick from pollTick + load at boot"
```

---

## Task 5: spec-kit module — command detection

Start the external module with the pure detector that recognizes a spec-kit slash command in a transcript record.

**Files:**
- Create: `examples/modules/spec-kit.js`
- Test: `examples/modules/spec-kit.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `extractCommand(record)` → `'/x'` | `null`. Returns the slash command from a `type:'user'` record whose content string contains `<command-name>/x</command-name>`; `null` otherwise.
  - The file's default export is the factory (assembled in Task 7); Tasks 5–6 attach pure helpers as properties for testing: `module.exports.extractCommand`, later `module.exports.decideReaction`.

- [ ] **Step 1: Write the failing test**

Create `examples/modules/spec-kit.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/modules/spec-kit.test.js`
Expected: FAIL — cannot find module `./spec-kit.js`.

- [ ] **Step 3: Write minimal implementation**

Create `examples/modules/spec-kit.js`:

```js
'use strict';
// spec-kit workflow module for the Claude Code Telegram gateway.
// Arms when a spec-kit slash command appears in a watched session; on settle it
// injects /compact after non-terminal steps and spawns a fresh /code-review
// session when the terminal step (/implement) completes.
//
// External module: lives outside the published package, loaded via config.MODULES.

// A spec-kit step shows up as a user record containing <command-name>/x</command-name>.
function recordText(record) {
  if (!record || record.type !== 'user' || !record.message) return '';
  const c = record.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ');
  return '';
}

function extractCommand(record) {
  const t = recordText(record);
  const mtch = /<command-name>\s*(\/[a-z0-9:_-]+)\s*<\/command-name>/i.exec(t);
  return mtch ? mtch[1].toLowerCase() : null;
}

module.exports = () => ({ name: 'spec-kit' });   // real factory assembled in Task 7
module.exports.extractCommand = extractCommand;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/modules/spec-kit.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/modules/spec-kit.js examples/modules/spec-kit.test.js
git commit -m "feat(spec-kit): slash-command detection"
```

---

## Task 6: spec-kit module — settle-driven reaction decision

Pure decision function: given a session's armed state and idle time, decide whether to compact, review, or do nothing.

**Files:**
- Modify: `examples/modules/spec-kit.js`
- Test: `examples/modules/spec-kit.test.js`

**Interfaces:**
- Consumes: `extractCommand` (Task 5).
- Produces:
  - `decideReaction(sessionState, cfg, now, mtime)` → `{ action: 'compact'|'review'|null, step: string|null }`.
    - `sessionState`: `{ armedStep, armedAt, firedSteps: [], reviewFired }`.
    - `cfg`: `{ terminalCommand, settleMs, reviewSettleMs }`.
    - Idle = `now - mtime`. Fires only when a step is armed, that step is not already in `firedSteps` (and, for the terminal step, `reviewFired` is false), and idle ≥ the relevant threshold (`reviewSettleMs` for `terminalCommand`, else `settleMs`).
    - Non-terminal armed step ⇒ `{ action: 'compact', step: armedStep }`. Terminal ⇒ `{ action: 'review', step: armedStep }`. Otherwise `{ action: null, step: null }`.

- [ ] **Step 1: Write the failing test**

Add to `examples/modules/spec-kit.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/modules/spec-kit.test.js`
Expected: FAIL — `m.decideReaction is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `examples/modules/spec-kit.js`, before the `module.exports = ...` line:

```js
// Settle-driven: a step is "done" once the transcript has been idle (no writes)
// for the threshold window since the step was armed. Terminal step uses a longer
// window because a false positive there spawns a whole review session.
function decideReaction(sessionState, cfg, now, mtime) {
  const none = { action: null, step: null };
  const s = sessionState;
  if (!s || !s.armedStep) return none;
  const isTerminal = s.armedStep === cfg.terminalCommand;
  if (isTerminal && s.reviewFired) return none;
  if (!isTerminal && (s.firedSteps || []).includes(s.armedStep)) return none;
  const idle = now - mtime;
  const threshold = isTerminal ? cfg.reviewSettleMs : cfg.settleMs;
  if (idle < threshold) return none;
  return isTerminal ? { action: 'review', step: s.armedStep } : { action: 'compact', step: s.armedStep };
}
```

Add the export property after the existing `extractCommand` export line:

```js
module.exports.decideReaction = decideReaction;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/modules/spec-kit.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add examples/modules/spec-kit.js examples/modules/spec-kit.test.js
git commit -m "feat(spec-kit): settle-driven reaction decision"
```

---

## Task 7: spec-kit module — assemble the factory

Wire the pure helpers to the `api`: arm on `transcriptLine`, react on `tick`, persisting per-session state and deduping fires.

**Files:**
- Modify: `examples/modules/spec-kit.js`
- Test: `examples/modules/spec-kit.test.js`

**Interfaces:**
- Consumes: `extractCommand` (5), `decideReaction` (6); the `api` from Task 3 (`state`, `injectTurn`, `spawnSession`, `postToTopic`, `getSessionInfo`, `config`).
- Produces: the factory `module.exports = (api) => ({ name, onTranscriptLine, onTick })`.
  - Config (from `api.config`, with defaults): `STEP_COMMANDS` (default `['/specify','/clarify','/plan','/tasks','/analyze','/implement']`), `TERMINAL_COMMAND` (`/implement`), `SPEC_KIT_SETTLE_SECONDS` (30), `SPEC_KIT_REVIEW_SETTLE_SECONDS` (90).
  - `onTranscriptLine(ctx, record)`: if `extractCommand(record)` ∈ `STEP_COMMANDS`, set `state.data[ctx.sessionId]` to `{ armedStep, armedAt: Date.now(), firedSteps: prev.firedSteps||[], reviewFired: prev.reviewFired||false }`, `save()`.
  - `onTick(now)`: for each tracked sessionId, `info = api.getSessionInfo(id)`; skip if none; `decideReaction(...)`; on `compact` → `api.injectTurn(id, '/compact')`, `api.postToTopic(id, '✅ spec-kit: <step> done → compacting')`, push step to `firedSteps`; on `review` → `api.spawnSession({ cwd: info.cwd, prompt: '/code-review', mode: undefined })`, `api.postToTopic(id, '🔍 implementation complete → launching review')`, set `reviewFired`; `save()` after any change.

- [ ] **Step 1: Write the failing test**

Add to `examples/modules/spec-kit.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/modules/spec-kit.test.js`
Expected: FAIL — the placeholder factory returns only `{ name }`, so `mod.onTranscriptLine` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `examples/modules/spec-kit.js`, replace the placeholder line
`module.exports = () => ({ name: 'spec-kit' });` with:

```js
const DEFAULT_STEPS = ['/specify', '/clarify', '/plan', '/tasks', '/analyze', '/implement'];

function factory(api) {
  const cfgSrc = (api && api.config) || {};
  const STEP_COMMANDS = Array.isArray(cfgSrc.STEP_COMMANDS) ? cfgSrc.STEP_COMMANDS.map((c) => c.toLowerCase()) : DEFAULT_STEPS;
  const cfg = {
    terminalCommand: (cfgSrc.TERMINAL_COMMAND || '/implement').toLowerCase(),
    settleMs: (cfgSrc.SPEC_KIT_SETTLE_SECONDS || 30) * 1000,
    reviewSettleMs: (cfgSrc.SPEC_KIT_REVIEW_SETTLE_SECONDS || 90) * 1000,
  };
  const store = api.state('spec-kit');   // { data, save() }

  return {
    name: 'spec-kit',
    onTranscriptLine(ctx, record) {
      const cmd = extractCommand(record);
      if (!cmd || !STEP_COMMANDS.includes(cmd)) return;   // /compact & /code-review excluded → no re-arm
      const prev = store.data[ctx.sessionId] || {};
      store.data[ctx.sessionId] = {
        armedStep: cmd,
        armedAt: Date.now(),
        firedSteps: prev.firedSteps || [],
        reviewFired: prev.reviewFired || false,
      };
      store.save();
    },
    onTick(now) {
      let changed = false;
      for (const sessionId of Object.keys(store.data)) {
        const s = store.data[sessionId];
        const info = api.getSessionInfo(sessionId);
        if (!info) continue;
        const { action, step } = decideReaction(s, cfg, now, info.mtime || 0);
        if (action === 'compact') {
          api.injectTurn(sessionId, '/compact');
          api.postToTopic(sessionId, `✅ spec-kit: ${step} done → compacting`);
          s.firedSteps = (s.firedSteps || []).concat(step);
          changed = true;
        } else if (action === 'review') {
          api.spawnSession({ cwd: info.cwd, prompt: '/code-review', mode: undefined });
          api.postToTopic(sessionId, '🔍 implementation complete → launching review');
          s.reviewFired = true;
          changed = true;
        }
      }
      if (changed) store.save();
    },
  };
}

module.exports = factory;
```

Keep the existing `module.exports.extractCommand` / `module.exports.decideReaction` property assignments (they must come after `module.exports = factory;`, so move/verify they sit at the end of the file).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/modules/spec-kit.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add examples/modules/spec-kit.js examples/modules/spec-kit.test.js
git commit -m "feat(spec-kit): assemble module factory (arm + settle react)"
```

---

## Task 8: Config, docs, and test wiring

Document the `MODULES` config key, describe how to install an external module, and make `npm test` run the example module's tests.

**Files:**
- Modify: `config.example.json`
- Modify: `package.json` (`test` script)
- Create: `examples/modules/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. No new code.

- [ ] **Step 1: Add the MODULES key to config.example.json**

Add a top-level key (near the other optional keys). Value is an empty array with a documented default:

```json
  "MODULES": []
```

(Empty by default = no-op. Populated example: `["~/.claude-gateway/modules/spec-kit.js"]`.)

- [ ] **Step 2: Extend the test script**

In `package.json`, change:

```json
    "test": "node --test test/*.test.js"
```
to:
```json
    "test": "node --test test/*.test.js examples/modules/*.test.js"
```

- [ ] **Step 3: Write examples/modules/README.md**

Create `examples/modules/README.md`:

```markdown
# Gateway modules

External files that extend the gateway against a stable `api`. They are **not**
part of the published npm package — copy one into your state dir and list it in
`config.json`.

## Install a module

1. Copy the module next to your gateway state:
   `cp spec-kit.js ~/.claude-gateway/modules/spec-kit.js`
2. Add it to `config.json`:
   ```json
   "MODULES": ["~/.claude-gateway/modules/spec-kit.js"]
   ```
3. Restart: `touch ~/.claude-gateway/restart.flag`
   (never `launchctl kickstart -k` from a phone-driven turn — it self-kills).

Paths resolve against `$CLAUDE_GATEWAY_DIR` (default `~/.claude-gateway`) or may
be absolute. Empty or absent `MODULES` is a pure no-op.

## The module contract

A module is a factory that receives the `api` and returns hooks:

    module.exports = (api) => ({
      name: 'spec-kit',
      onTranscriptLine(ctx, record) { /* each new transcript record */ },
      onTick(now)                   { /* once per poll tick */ },
    });

`ctx = { sessionId, cwd, chatId, threadId }`. Every hook is optional. A throwing
hook is logged and skipped — it can't crash the gateway or other modules.

### api

| method | purpose |
|---|---|
| `api.injectTurn(sessionId, prompt)` | queue a turn into the session (rides the idle gate) |
| `api.spawnSession({cwd, prompt, mode})` | fresh detached `claude -p`; returns the new session id |
| `api.postToTopic(sessionId, text)` | status line into the session's topic |
| `api.getSessionInfo(sessionId)` | `{ cwd, chatId, threadId, label, mtime }` or null |
| `api.state(name)` | `{ data, save() }` persisted JSON, namespaced per module |
| `api.config` | the gateway config (read-only) |
| `api.log(...)` | namespaced logging |

## spec-kit

Auto-detects any session running a spec-kit flow
(`/specify → /clarify → /plan → /tasks → /analyze → /implement`). After each
non-terminal step settles it injects `/compact`; when `/implement` settles it
spawns a fresh `/code-review` session in the same repo (its own topic appears in
Telegram). Config keys (all optional): `STEP_COMMANDS`, `TERMINAL_COMMAND`,
`SPEC_KIT_SETTLE_SECONDS` (30), `SPEC_KIT_REVIEW_SETTLE_SECONDS` (90).
```

- [ ] **Step 4: Add a Modules section to README.md**

Append a short section under the existing feature docs:

```markdown
## Modules (optional)

The gateway can load external modules that extend it against a stable `api`
without modifying the package. List them in `config.json`:

    "MODULES": ["~/.claude-gateway/modules/spec-kit.js"]

Empty or absent = no-op. See `examples/modules/` for the contract and the
bundled `spec-kit` module (compacts a spec-kit session between steps and spawns
a `/code-review` session when `/implement` finishes).
```

- [ ] **Step 5: Run the full suite**

Run: `node --test test/*.test.js examples/modules/*.test.js`
Expected: PASS — every test across core and the spec-kit module.

- [ ] **Step 6: Verify the module is excluded from the package**

Run: `npm pack --dry-run 2>/dev/null | grep -c 'examples/'`
Expected: `0` — nothing under `examples/` is in the tarball (it is not in the `files` whitelist).

- [ ] **Step 7: Commit**

```bash
git add config.example.json package.json README.md examples/modules/README.md
git commit -m "docs(modules): config key, module authoring guide, test wiring"
```

---

## Manual / integration acceptance (post-implementation)

Not a unit test — the live run is the real acceptance, as with auto-approve:

1. `cp examples/modules/spec-kit.js ~/.claude-gateway/modules/spec-kit.js`
2. Add `"MODULES": ["~/.claude-gateway/modules/spec-kit.js"]` to `~/.claude-gateway/config.json`.
3. `touch ~/.claude-gateway/restart.flag` and confirm the boot log prints `Modules: spec-kit`.
4. Drive a real spec-kit flow from the phone in a mapped repo. Confirm:
   - each non-terminal step posts `✅ spec-kit: <step> done → compacting` and a `/compact` runs;
   - after `/implement` settles, a `🔍 implementation complete → launching review` line posts and a fresh `/code-review` topic appears and mirrors.
5. If review fires too eagerly during a long `/implement` pause, raise `SPEC_KIT_REVIEW_SETTLE_SECONDS` in config and re-`touch restart.flag`.

---

## Self-Review

**Spec coverage:**
- Module system: registry (T1), loader/config (T2), api + spawnSession (T3), dispatch points + boot (T4). ✓
- api table (injectTurn/spawnSession/postToTopic/getSessionInfo/state/config/log): T3. ✓ (added `api.config` so the module reads its own thresholds — a spec detail left to the plan.)
- `onTelegramUpdate` deferred: honored — not built. ✓
- Isolation via per-module try/catch: T1. ✓
- OSS no-op guarantee: T1/T2 tests assert empty MODULES is inert. ✓
- spec-kit detection (T5), settle reaction with two thresholds (T6), arm/react/dedup/loop-safety (T7). ✓
- Same-cwd review (no worktree): T7 spawns with `info.cwd`. ✓
- Package exclusion: `examples/` outside `files` whitelist; T8 step 6 verifies. ✓
- State growth pruning (spec §Reliability): **partially deferred** — per-session state accumulates in `module-spec-kit` json; entries are small and bounded by active spec-kit sessions. Not pruned on session-drop in v1; noted here as acceptable (a spec-kit session is rare and the state object is tiny). If it matters later, add a `sessionDropped` hook. This is a conscious scope call, consistent with the spec's "or lazily expire."

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `createModuleRegistry(instances, log)` → `{emit, names}` used consistently in T2/T4. `decideReaction(sessionState, cfg, now, mtime)` signature identical in T6 and T7. `api.state(name)` → `{data, save()}` consistent T3/T7. `getSessionInfo` returns `{cwd, chatId, threadId, label, mtime}` in T3, consumed as `info.cwd`/`info.mtime` in T7. ✓
