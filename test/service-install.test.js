'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const plist = fs.readFileSync(path.join(root, 'com.claude.telegram-gateway.plist'), 'utf8');

// `__DIR__` is the install directory, which for the common `npm install -g` case IS
// the package directory. Anything the service writes there is destroyed by the next
// `npm install -g`, which unlinks the tree: the running process keeps writing to an
// unlinked inode and every line of history is gone. Found on a laptop that lost its
// entire gateway log to a routine version update. State belongs in the state dir,
// which is also where the config and restart.flag already live.
test('the service writes its log outside the package directory', () => {
  const logPaths = [...plist.matchAll(/<key>Standard(?:Out|Error)Path<\/key>\s*<string>([^<]+)<\/string>/g)]
    .map((m) => m[1]);
  assert.ok(logPaths.length >= 1, 'plist declares no log path at all');
  for (const p of logPaths) {
    assert.ok(!p.includes('__DIR__'),
      `log path is inside the install dir and an npm update would unlink it: ${p}`);
    assert.match(p, /^__HOME__\/\.claude-gateway\//,
      `log path should sit in the state dir alongside config.json: ${p}`);
  }
});

// The install script substitutes the placeholders. A path it never creates makes
// launchd fail to start the service with a bare I/O error and no explanation.
test('the installer creates the directory it points the log at', () => {
  const sh = fs.readFileSync(path.join(root, 'install-service.sh'), 'utf8');
  assert.match(sh, /mkdir -p "\$HOME\/\.claude-gateway"/,
    'install-service.sh must create the state dir before launchd writes a log into it');
});

test('every placeholder the plist uses is substituted by the installer', () => {
  const used = new Set([...plist.matchAll(/__([A-Z]+)__/g)].map((m) => m[0]));
  const sh = fs.readFileSync(path.join(root, 'install-service.sh'), 'utf8');
  const missing = [...used].filter((ph) => !sh.includes(`s|${ph}|`));
  assert.deepEqual(missing, [], `plist placeholders never substituted: ${missing.join(', ')}`);
});

// The installer substituted PATH as "$NODE_DIR:/usr/local/bin:/usr/bin:...".
// Two defects, both found on a laptop by reading its generated plist:
//  - when node already lives in /usr/local/bin, that entry appears twice
//  - /opt/homebrew/bin is absent, so nothing Homebrew-installed resolves for the
//    daemon even though Homebrew is where a Mac keeps most of its tools
// A duplicate is only untidy; the missing entry is what makes a spawn fail with
// "command not found" in a process nobody is watching.
//
// These run the real installer against a stubbed launchctl and a fake HOME, then
// read the PATH out of the plist it actually generated. Parsing the substitution
// string instead would only re-check the shell expression, which is the part that
// was already wrong once.
const os = require('os');
const { spawnSync } = require('child_process');

function generatedPath(nodeBin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-inst-'));
  const bin = path.join(home, 'stubbin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755);

  // GATEWAY_NODE names the interpreter, so a system layout such as node living in
  // /usr/local/bin can be simulated without writing to a real system directory.
  const r = spawnSync('bash', [path.join(root, 'install-service.sh')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, GATEWAY_NODE: nodeBin },
  });
  const pl = path.join(home, 'Library', 'LaunchAgents', 'com.claude.telegram-gateway.plist');
  const text = fs.existsSync(pl) ? fs.readFileSync(pl, 'utf8') : '';
  fs.rmSync(home, { recursive: true, force: true });
  const m = text.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
  return { path: m ? m[1] : '', out: `${r.stdout}${r.stderr}` };
}

test('the generated PATH includes Homebrew, where a Mac keeps its tools', () => {
  const g = generatedPath('/opt/node/bin/node');
  assert.ok(g.path, `no PATH in the generated plist:\n${g.out}`);
  assert.match(g.path, /\/opt\/homebrew\/bin/,
    `a Homebrew-installed binary would not resolve for the daemon: ${g.path}`);
});

test('the generated PATH does not repeat an entry when node already sits in it', () => {
  for (const nodeDir of ['/usr/local/bin', '/opt/node/bin']) {
    const g = generatedPath(`${nodeDir}/node`);
    const parts = g.path.split(':').filter(Boolean);
    const dupes = parts.filter((d, i) => parts.indexOf(d) !== i);
    assert.deepEqual(dupes, [], `PATH repeats ${dupes.join(', ')} when node is in ${nodeDir}: ${g.path}`);
  }
});
