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
