const { test } = require('node:test');
const assert = require('node:assert');
const { createTelemetry, attrKey } = require('../telemetry');

test('attrKey sorts attributes for a stable key', () => {
  assert.strictEqual(attrKey('m', { b: '2', a: '1' }), 'm{a=1,b=2}');
  assert.strictEqual(attrKey('m', {}), 'm');
});

test('count accumulates per attribute set', () => {
  const t = createTelemetry();
  t.count('gateway.claude.turn', { repo: 'x', mode: 'new' });
  t.count('gateway.claude.turn', { repo: 'x', mode: 'new' });
  t.count('gateway.claude.turn', { repo: 'x', mode: 'resume' });
  const snap = t.snapshot();
  const news = snap.counters.find(c => c.attrs.mode === 'new');
  const res = snap.counters.find(c => c.attrs.mode === 'resume');
  assert.strictEqual(news.value, 2);
  assert.strictEqual(res.value, 1);
});

test('record tracks count/sum/min/max', () => {
  const t = createTelemetry();
  t.record('gateway.topic.backoff_seconds', 60);
  t.record('gateway.topic.backoff_seconds', 900);
  const h = t.snapshot().histos[0];
  assert.strictEqual(h.count, 2);
  assert.strictEqual(h.sum, 960);
  assert.strictEqual(h.min, 60);
  assert.strictEqual(h.max, 900);
});

test('observables evaluate at snapshot time', () => {
  const t = createTelemetry();
  let n = 3;
  t.registerObservable('gateway.sessions.active', () => n);
  assert.strictEqual(t.snapshot().observables['gateway.sessions.active'], 3);
  n = 5;
  assert.strictEqual(t.snapshot().observables['gateway.sessions.active'], 5);
});

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

test('persist writes stats.json and start() reloads counters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-'));
  const t1 = createTelemetry({ dir });
  t1.count('gateway.access.blocked');
  t1.count('gateway.access.blocked');
  return t1.flush().then(() => {
    assert.ok(fs.existsSync(path.join(dir, 'stats.json')));
    const t2 = createTelemetry({ dir });
    t2.start();
    const blocked = t2.snapshot().counters.find(c => c.name === 'gateway.access.blocked');
    assert.strictEqual(blocked.value, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
