'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

// The published tarball is defined by package.json "files", which is an allowlist:
// a runtime file left off it is silently dropped and the installed gateway dies at
// require time. Ask npm what it would actually ship rather than re-deriving the rules.
// Reading only one report shape is what turned this guard into the thing that broke
// the release: CI installs npm@latest, whose report is a map keyed by package name,
// so the test threw before it could check anything. A shape it cannot read is an
// assertion failure, never a silent pass.
function packedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const start = out.search(/[[{]/);
  assert.ok(start >= 0, `npm pack --json produced no JSON:\n${out}`);
  const report = pickReport(JSON.parse(out.slice(start)));
  assert.ok(report && Array.isArray(report.files),
    `npm pack --json shape not recognized: ${out.slice(start, start + 200)}`);
  return new Set(report.files.map((f) => f.path));
}

// Three shapes, all of them from npm itself: a single-element array (npm 11 and
// earlier), a bare report object, and a map keyed by package name (npm 12).
function pickReport(parsed) {
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed && Array.isArray(parsed.files)) return parsed;
  if (parsed && typeof parsed === 'object') {
    return Object.values(parsed).find((v) => v && Array.isArray(v.files));
  }
  return undefined;
}

function localRequires(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const targets = [];
  for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) targets.push(m[1]);
  return targets;
}

function resolveFrom(file, spec) {
  const abs = require.resolve(path.resolve(root, path.dirname(file), spec));
  return path.relative(root, abs);
}

test('every runtime require of an entrypoint is inside the published tarball', () => {
  const packed = packedFiles();
  const entrypoints = ['gateway.js', 'setup.js', 'resume-hook.js', 'bin/claude-tg.js'];
  const missing = [];
  for (const entry of entrypoints) {
    assert.ok(packed.has(entry), `entrypoint ${entry} is not in the tarball`);
    for (const spec of localRequires(entry)) {
      const target = resolveFrom(entry, spec);
      if (!packed.has(target)) missing.push(`${entry} requires ${spec} -> ${target}`);
    }
  }
  assert.deepEqual(missing, [], `runtime files missing from package.json "files":\n${missing.join('\n')}`);
});

test('the test script only references paths the tarball carries', () => {
  const packed = packedFiles();
  const script = require(path.join(root, 'package.json')).scripts.test;
  const dirs = [...script.matchAll(/([\w/.-]+)\/\*\.test\.js/g)].map((m) => m[1]);
  const missing = dirs.filter((d) => ![...packed].some((f) => f.startsWith(`${d}/`)));
  assert.deepEqual(missing, [], `npm test references directories the tarball omits: ${missing.join(', ')}`);
});
