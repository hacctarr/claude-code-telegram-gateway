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

test('buildOtlpPayload emits sum/gauge/histogram with correct shape', () => {
  const t = createTelemetry();
  t.count('gateway.claude.turn', { repo: 'docs', mode: 'new' });
  t.record('gateway.topic.backoff_seconds', 120);
  t.registerObservable('gateway.up', () => 1);
  const snap = t.snapshot();
  const payload = t.buildOtlpPayload(snap, 1700000000000000000n);
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;

  const turn = metrics.find(m => m.name === 'gateway.claude.turn');
  assert.strictEqual(turn.sum.isMonotonic, true);
  assert.strictEqual(turn.sum.aggregationTemporality, 2);
  assert.strictEqual(turn.sum.dataPoints[0].asDouble, 1);
  const attrs = turn.sum.dataPoints[0].attributes.map(a => a.key).sort();
  assert.deepStrictEqual(attrs, ['mode', 'repo']);

  const backoff = metrics.find(m => m.name === 'gateway.topic.backoff_seconds');
  assert.strictEqual(backoff.histogram.dataPoints[0].count, '1');
  assert.strictEqual(backoff.histogram.dataPoints[0].sum, 120);
  // bucketCounts length must equal explicitBounds length + 1
  assert.strictEqual(
    backoff.histogram.dataPoints[0].bucketCounts.length,
    backoff.histogram.dataPoints[0].explicitBounds.length + 1
  );

  const up = metrics.find(m => m.name === 'gateway.up');
  assert.strictEqual(up.gauge.dataPoints[0].asDouble, 1);

  const res = payload.resourceMetrics[0].resource.attributes.find(a => a.key === 'service.name');
  assert.strictEqual(res.value.stringValue, 'telegram-gateway');
});

test('exportOtlp POSTs to /v1/metrics with basic auth; skips when disabled', async () => {
  const captured = {};
  const fakeHttps = {
    request(options, cb) {
      captured.options = options;
      const res = { statusCode: 200, resume() {}, on(ev, fn) { if (ev === 'end') fn(); } };
      return {
        on() {},
        write(body) { captured.body = body; },
        end() { cb(res); },
      };
    },
  };

  const disabled = createTelemetry({ httpsMod: fakeHttps, otlp: { enabled: false } });
  disabled.count('gateway.access.blocked');
  assert.deepStrictEqual(await disabled.exportOtlp(), { skipped: true });

  const t = createTelemetry({
    httpsMod: fakeHttps,
    otlp: { enabled: true, endpoint: 'https://otlp-gateway-prod.grafana.net/otlp', auth: 'QUJDOnRvaw==' },
  });
  t.count('gateway.access.blocked');
  const r = await t.exportOtlp();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(captured.options.path, '/otlp/v1/metrics');
  assert.strictEqual(captured.options.headers.Authorization, 'Basic QUJDOnRvaw==');
  const parsed = JSON.parse(captured.body);
  assert.ok(parsed.resourceMetrics[0].scopeMetrics[0].metrics.length >= 1);
});
