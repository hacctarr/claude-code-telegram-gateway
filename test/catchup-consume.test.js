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

// Full injected context for executeCatchupRebind, recording every persist and resume write.
function mkCtx({ forkLinked = true, deskSize = 900, forkSize = 500, queued = null } = {}) {
  const calls = [];
  const links = forkLinked
    ? { 'fork-1': { chatId: '-100', threadId: 7, label: 'the work', offset: 480,
                    forkedFrom: 'desk-1', mirrorCursor: { offset: 480, activity: 1, prose: 0 } } }
    : {};
  const queues = new Map();
  if (queued) queues.set('fork-1', queued);
  const ctx = {
    links,
    superseded: { 'desk-1': 400 },
    queues,
    threadIndex: new Map(forkLinked ? [['-100_7', 'fork-1']] : []),
    sizeCurrent: (sid) => (sid === 'fork-1' ? forkSize : deskSize),
    writeResumeMarker: (repo, sid) => calls.push(['resume', repo, sid]),
    persistLinks: () => calls.push(['persistLinks']),
    persistSuperseded: () => calls.push(['persistSuperseded']),
  };
  return { ctx, calls };
}

test('executeCatchupRebind: superseded flips both directions and persists', () => {
  const { ctx, calls } = mkCtx();
  g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.equal(ctx.superseded['desk-1'], undefined, 'desk is live again');
  assert.equal(ctx.superseded['fork-1'], 500, 'fork superseded at its final size');
  assert.ok(calls.some((c) => c[0] === 'persistSuperseded'));
});

test('executeCatchupRebind: link moves to the desk sid, topic identity and label carried', () => {
  const { ctx, calls } = mkCtx();
  const r = g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.deepEqual(r, { rebound: true, chatId: '-100', threadId: 7 });
  assert.equal(ctx.links['fork-1'], undefined);
  const l = ctx.links['desk-1'];
  assert.equal(l.chatId, '-100');
  assert.equal(l.threadId, 7);
  assert.equal(l.label, 'the work');
  assert.equal(l.closed, false);
  assert.equal(l.offset, 900, 'offset jumps past the ingested digest');
  assert.equal(l.forkedFrom, undefined, 'a self-referential forkedFrom must not ride along');
  assert.equal(l.mirrorCursor, undefined, 'a stale cursor dies with the old offset');
  assert.equal(ctx.threadIndex.get('-100_7'), 'desk-1');
  assert.ok(calls.some((c) => c[0] === 'persistLinks'));
});

test('executeCatchupRebind: queued replies and the resume marker follow the desk sid', () => {
  const { ctx, calls } = mkCtx({ queued: ['queued reply'] });
  g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.deepEqual(ctx.queues.get('desk-1'), ['queued reply']);
  assert.equal(ctx.queues.has('fork-1'), false);
  assert.ok(calls.some((c) => c[0] === 'resume' && c[1] === '/r' && c[2] === 'desk-1'));
});

test('executeCatchupRebind: fork without a link still swaps superseded state and resume marker', () => {
  const { ctx } = mkCtx({ forkLinked: false });
  const r = g.executeCatchupRebind('desk-1', entry(), ctx);
  assert.deepEqual(r, { rebound: false });
  assert.equal(ctx.superseded['desk-1'], undefined);
  assert.equal(ctx.superseded['fork-1'], 500);
  assert.equal(ctx.links['desk-1'], undefined, 'no link is conjured for a closed topic');
});
