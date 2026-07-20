#!/usr/bin/env node
'use strict';
// Thin CLI so the package works via `npx claude-code-telegram-gateway <cmd>` or a global install.
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const run = (file, args = []) => execFileSync(file, args, { cwd: ROOT, stdio: 'inherit' });
const node = (rel) => run(process.execPath, [path.join(ROOT, rel)]);

const cmd = process.argv[2];
try {
  switch (cmd) {
    case 'setup': node('setup.js'); break;
    case 'start': node('gateway.js'); break;
    case 'check': node('test/check-telegram.js'); break;
    case 'doctor': run('/bin/bash', [path.join(ROOT, 'test', 'doctor.sh')]); break;
    case 'install': case 'install-service': run(path.join(ROOT, 'install-service.sh')); break;
    case 'uninstall': case 'uninstall-service': run(path.join(ROOT, 'uninstall-service.sh')); break;
    default:
      console.log(`claude-tg <command>

  setup       interactive config (bot token, your id, group→repo mappings)
  start       run the gateway in the foreground
  check       verify the bot's Telegram permissions
  doctor      report install/config/state paths and signs of runaway cost
  install     install as a launchd background service (auto-start + restart)
  uninstall   stop and remove the service`);
  }
} catch (e) {
  process.exit(e.status || 1);
}
