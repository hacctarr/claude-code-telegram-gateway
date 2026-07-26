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
        setTimeout() {},
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

test('buildOtlpPayload encodes numeric attribute values as intValue', () => {
  const t = createTelemetry();
  t.gauge('gateway.sessions.active', 3, { shard: 2 });
  const payload = t.buildOtlpPayload(t.snapshot(), 1700000000000000000n);
  const m = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(x => x.name === 'gateway.sessions.active');
  const attr = m.gauge.dataPoints[0].attributes.find(a => a.key === 'shard');
  assert.deepStrictEqual(attr.value, { intValue: '2' });
});

test('buildOtlpPayload encodes non-integer numeric attribute values as doubleValue', () => {
  const t = createTelemetry();
  t.gauge('gateway.load.factor', 1, { ratio: 0.5 });
  const payload = t.buildOtlpPayload(t.snapshot(), 1700000000000000000n);
  const m = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(x => x.name === 'gateway.load.factor');
  const attr = m.gauge.dataPoints[0].attributes.find(a => a.key === 'ratio');
  assert.deepStrictEqual(attr.value, { doubleValue: 0.5 });
});

test('exportOtlp sets a request timeout so a hung endpoint still settles the promise', async () => {
  let timeoutMs;
  let timeoutCb;
  const fakeHttps = {
    request(options, cb) {
      const req = {
        _errorHandler: null,
        on(ev, fn) { if (ev === 'error') req._errorHandler = fn; },
        setTimeout(ms, fn) { timeoutMs = ms; timeoutCb = fn; },
        write() {},
        end() {},
        destroy(err) { if (req._errorHandler) req._errorHandler(err); },
      };
      return req;
    },
  };

  const t = createTelemetry({
    httpsMod: fakeHttps,
    otlpTimeoutMs: 10000,
    otlp: { enabled: true, endpoint: 'https://otlp-gateway-prod.grafana.net/otlp', auth: 'QUJDOnRvaw==' },
  });
  t.count('gateway.access.blocked');

  const pending = t.exportOtlp();
  assert.strictEqual(timeoutMs, 10000);
  // Simulate the hung endpoint firing its timeout: destroy() should trigger
  // the existing error handler, which resolves the promise instead of hanging it.
  timeoutCb();
  const r = await pending;
  assert.ok(r.error);
});

const gw = require('../gateway');

test('repoOf maps a cwd under a mapped repo to its basename', () => {
  const mappings = { '111': '/Users/marc/telegram_gateway', '222': '/Users/marc/Documents' };
  assert.strictEqual(gw.repoOf('/Users/marc/Documents', mappings), 'Documents');
  assert.strictEqual(gw.repoOf('/Users/marc/Documents/sub/dir', mappings), 'Documents');
  assert.strictEqual(gw.repoOf('/tmp/whatever', mappings), 'whatever');
  assert.strictEqual(gw.repoOf('', mappings), 'unknown');
});

test('formatStats renders a compact summary from a snapshot', () => {
  const snap = {
    startMs: 0,
    counters: [
      { name: 'gateway.claude.turn', attrs: { repo: 'a', mode: 'new' }, value: 5 },
      { name: 'gateway.claude.turn', attrs: { repo: 'a', mode: 'resume' }, value: 7 },
      { name: 'gateway.drive.injection', attrs: { ok: 'true' }, value: 4 },
      { name: 'gateway.topic.created', attrs: { repo: 'a' }, value: 6 },
      { name: 'gateway.topic.pruned', attrs: { mode: 'close' }, value: 3 },
      { name: 'gateway.topic.create_failed', attrs: { reason: 'rate_limited' }, value: 23 },
      { name: 'gateway.access.blocked', attrs: {}, value: 1 },
    ],
    histos: [], gauges: [],
    observables: { 'gateway.sessions.active': 5 },
  };
  const out = gw.formatStats(snap, 4 * 3600000 + 5 * 60000);
  assert.match(out, /up 4h 5m/);
  assert.match(out, /Turns 12/);
  assert.match(out, /Injections 4/);
  assert.match(out, /Topics \+6 \/ pruned 3/);
  assert.match(out, /Topic failures 23 \(23 rate-limited\)/);
  assert.match(out, /Active sessions 5 · Blocked 1/);
});

test('buildCommandList includes /stats', () => {
  assert.ok(gw.buildCommandList().some(c => c.command === 'stats'));
});

test('config.example.json documents the otlp block', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.ok(cfg.otlp, 'otlp key present');
  assert.ok('endpoint' in cfg.otlp && 'auth' in cfg.otlp && 'enabled' in cfg.otlp);
  assert.strictEqual(cfg.otlp.enabled, false, 'example ships disabled so the gateway is a no-op out of the box');
});

test('grafana dashboard JSON is valid and targets normalized metric names', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dash = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'grafana', 'gateway-dashboard.json'), 'utf8'));
  const blob = JSON.stringify(dash);
  assert.match(blob, /gateway_claude_turn_total/);
  assert.match(blob, /gateway_topic_create_failed_total/);
  assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 3);
});

test('restart counter advances across a persist/reload cycle when start() precedes count()', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-restart-'));
  const a = createTelemetry({ dir });   // boot 1: load (empty) then increment
  a.start();
  a.count('gateway.restart');
  return a.flush().then(() => {
    const b = createTelemetry({ dir }); // boot 2: load persisted (1) then increment -> 2
    b.start();
    b.count('gateway.restart');
    const v = b.snapshot().counters.find((c) => c.name === 'gateway.restart').value;
    assert.strictEqual(v, 2, 'restart accumulates across boots (start loads, then count increments)');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('exportOtlp tags every payload with a device instance (friendly label overrides hostname)', async () => {
  const captured = {};
  const fakeHttps = {
    request(o, cb) {
      const res = { statusCode: 200, resume() {}, on(e, f) { if (e === 'end') f(); } };
      return { on() {}, setTimeout() {}, write(b) { captured.body = b; }, end() { cb(res); } };
    },
  };
  const t = createTelemetry({
    httpsMod: fakeHttps,
    hostname: 'raw-host',
    otlp: { enabled: true, endpoint: 'https://x.grafana.net/otlp', auth: 'QQ==', instance: 'personal-mac' },
  });
  t.count('gateway.access.blocked');
  await t.exportOtlp();
  const attrs = JSON.parse(captured.body).resourceMetrics[0].resource.attributes;
  const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
  assert.deepStrictEqual(byKey['service.name'], { stringValue: 'telegram-gateway' });
  assert.deepStrictEqual(byKey['host.name'], { stringValue: 'raw-host' });
  assert.deepStrictEqual(byKey['service.instance.id'], { stringValue: 'personal-mac' });
});

test('service.instance.id defaults to the hostname when otlp.instance is unset', async () => {
  const captured = {};
  const fakeHttps = {
    request(o, cb) {
      const res = { statusCode: 200, resume() {}, on(e, f) { if (e === 'end') f(); } };
      return { on() {}, setTimeout() {}, write(b) { captured.body = b; }, end() { cb(res); } };
    },
  };
  const t = createTelemetry({
    httpsMod: fakeHttps,
    hostname: 'raw-host',
    otlp: { enabled: true, endpoint: 'https://x.grafana.net/otlp', auth: 'QQ==' },
  });
  t.count('gateway.access.blocked');
  await t.exportOtlp();
  const attrs = JSON.parse(captured.body).resourceMetrics[0].resource.attributes;
  const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
  assert.deepStrictEqual(byKey['service.instance.id'], { stringValue: 'raw-host' });
});

// ---------------------------------------------------------------------------
// Send-failure visibility
// ---------------------------------------------------------------------------
// The mirror flood ran for hours without a single log line, because a Telegram 429 is a non-ok
// *response*, not an exception: the catch never fired and nothing counted the rejection. These
// classify every way a send can fail so the rate is visible in /stats and Grafana.
test('classifySendFailure: a 429 is rate_limited', () => {
  assert.strictEqual(gw.classifySendFailure({ ok: false, description: 'Too Many Requests: retry after 30' }), 'rate_limited');
});

test('classifySendFailure: any other non-ok response is rejected, not an error', () => {
  assert.strictEqual(gw.classifySendFailure({ ok: false, description: 'Bad Request: message is too long' }), 'rejected');
  assert.strictEqual(gw.classifySendFailure({ ok: false }), 'rejected');
  assert.strictEqual(gw.classifySendFailure(null), 'rejected', 'a missing body is a rejection, not a throw');
});

test('classifySendFailure: a thrown transport fault is error', () => {
  assert.strictEqual(gw.classifySendFailure(undefined, new Error('ETIMEDOUT')), 'error');
  assert.strictEqual(gw.classifySendFailure({ ok: false, description: 'retry after 5' }, new Error('boom')), 'error',
    'a throw wins over whatever partial body came back');
});

test('formatStats surfaces send failures and stalled mirror batches', () => {
  const snap = {
    startMs: 0,
    counters: [
      { name: 'gateway.send.failed', attrs: { reason: 'rate_limited' }, value: 41 },
      { name: 'gateway.send.failed', attrs: { reason: 'error' }, value: 2 },
      { name: 'gateway.mirror.batch_stalled', attrs: {}, value: 9 },
    ],
    histos: [], gauges: [], observables: {},
  };
  const out = gw.formatStats(snap, 60000);
  assert.match(out, /Send failures 43 \(41 rate-limited\)/, 'totals across reasons, names the rate-limited share');
  assert.match(out, /stalled batches 9/, 'a stalled batch is the flood signature, so it gets its own number');
});

test('formatStats stays quiet about sends when nothing has failed', () => {
  const snap = { startMs: 0, counters: [], histos: [], gauges: [], observables: {} };
  assert.ok(!/Send failures/.test(gw.formatStats(snap, 60000)), 'no noise on a healthy gateway');
});

test('sendChunked counts every failure mode against the live telemetry instance', async () => {
  const before = (reason) => gw.telemetry.snapshot().counters
    .filter((c) => c.name === 'gateway.send.failed' && c.attrs.reason === reason)
    .reduce((a, c) => a + c.value, 0);
  const [rl0, rej0, err0] = [before('rate_limited'), before('rejected'), before('error')];

  await gw.sendChunked('-1', 7, 'x', { send: async () => ({ ok: false, description: 'Too Many Requests: retry after 30' }) });
  await gw.sendChunked('-1', 7, 'x', { send: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
  await gw.sendChunked('-1', 7, 'x', { send: async () => { throw new Error('ETIMEDOUT'); } });

  assert.strictEqual(before('rate_limited'), rl0 + 1, '429 counted as rate_limited');
  assert.strictEqual(before('rejected'), rej0 + 1, 'non-ok body counted as rejected');
  assert.strictEqual(before('error'), err0 + 1, 'throw counted as error');
});

test('sendChunked counts nothing when the send succeeds', async () => {
  const total = () => gw.telemetry.snapshot().counters
    .filter((c) => c.name === 'gateway.send.failed').reduce((a, c) => a + c.value, 0);
  const t0 = total();
  const r = await gw.sendChunked('-1', 7, 'x', { send: async () => ({ ok: true, result: { message_id: 1 } }) });
  assert.strictEqual(r.allSent, true);
  assert.strictEqual(total(), t0, 'a healthy send is not counted as a failure');
});
