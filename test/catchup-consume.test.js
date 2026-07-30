'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const g = require('../gateway.js');

const NOW = 1_000_000_000;
const entry = (over = {}) => ({ forkId: 'fork-1', forkSize: 500, repoDir: '/r', ts: NOW, ...over });

function mkMarker(m) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-consume-'));
  const file = path.join(dir, 'catchup.json');
  if (m !== undefined) fs.writeFileSync(file, JSON.stringify(m));
  return file;
}

test('readCatchupRequests: fresh entries returned, stale and malformed excluded from fresh', () => {
  const file = mkMarker({
    'desk-1': entry(),
    'desk-2': entry({ ts: NOW - g.CATCHUP_STALE_MS - 1 }),
    'desk-3': { ts: NOW },                       // no forkId: malformed
  });
  const { fresh, all } = g.readCatchupRequests(file, NOW);
  assert.deepEqual(Object.keys(fresh), ['desk-1']);
  assert.deepEqual(all.sort(), ['desk-1', 'desk-2', 'desk-3']);
});

test('readCatchupRequests: missing or unparseable file is empty, never throws', () => {
  assert.deepEqual(g.readCatchupRequests(mkMarker(), NOW), { fresh: {}, all: [] });
  const file = mkMarker(); fs.writeFileSync(file, 'not json');
  assert.deepEqual(g.readCatchupRequests(file, NOW), { fresh: {}, all: [] });
});

test('removeCatchupEntries: drops named sids, keeps entries written meanwhile, unlinks when empty', () => {
  const file = mkMarker({ 'desk-1': entry(), 'desk-2': entry({ forkId: 'fork-2' }) });
  g.removeCatchupEntries(file, ['desk-1']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['desk-2']);
  g.removeCatchupEntries(file, ['desk-2']);
  assert.ok(!fs.existsSync(file), 'empty marker file is removed');
});

test('hasPendingCatchup: true only for a fresh entry', () => {
  const file = mkMarker({ 'desk-1': entry(), 'desk-2': entry({ ts: NOW - g.CATCHUP_STALE_MS - 1 }) });
  assert.equal(g.hasPendingCatchup('desk-1', file, NOW), true);
  assert.equal(g.hasPendingCatchup('desk-2', file, NOW), false);
  assert.equal(g.hasPendingCatchup('desk-9', file, NOW), false);
});

test('catchupDecision: fork growth after the digest declines, unchanged rebinds', () => {
  assert.equal(g.catchupDecision(entry({ forkSize: 500 }), 501), 'decline');
  assert.equal(g.catchupDecision(entry({ forkSize: 500 }), 500), 'rebind');
});
