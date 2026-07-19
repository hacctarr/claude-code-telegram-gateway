#!/usr/bin/env node
'use strict';
// Prints "<repoDir>\t<sessionId>" for the newest phone-driven branch and consumes it, so a shell
// hook can auto-resume it. Prints nothing when there's nothing pending. Multi-repo aware.
const fs = require('fs');
const path = require('path');
const MARKER = path.join(process.env.HOME, '.claude-gateway', 'resume.json');
try {
  const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
  const entries = Object.entries(m).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  if (!entries.length) process.exit(0);
  const [repo, info] = entries[0];
  process.stdout.write(`${repo}\t${info.sessionId}`);
  delete m[repo];
  if (Object.keys(m).length) fs.writeFileSync(MARKER, JSON.stringify(m, null, 2));
  else fs.unlinkSync(MARKER);
} catch (e) { /* no marker → nothing to resume */ }
