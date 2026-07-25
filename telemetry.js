// telemetry.js: zero-dependency metrics for the gateway. Built-in `https` only.
// Kept self-contained so this fork stays cleanly mergeable against upstream.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function attrKey(name, attrs) {
  const parts = Object.keys(attrs).sort().map((k) => `${k}=${attrs[k]}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

function createTelemetry(opts = {}) {
  const {
    dir = null,
    otlp = {},
    flushIntervalMs = 30000,
    otlpTimeoutMs = 10000,
    now = () => Date.now(),
    httpsMod = https,
    hostname = os.hostname(),
  } = opts;

  // Device tag. In Grafana Cloud's OTLP->Prometheus mapping, `service.instance.id`
  // becomes the `instance` label on every series (so two machines' metrics stay
  // separate and their cumulative counters don't collide), while `host.name` lands
  // in target_info. Default the instance to the hostname; `otlp.instance` overrides
  // it with a friendly label (e.g. "personal-mac").
  const resourceAttrs = {
    'host.name': hostname,
    'service.instance.id': otlp.instance ? String(otlp.instance) : hostname,
  };

  const counters = new Map();
  const gauges = new Map();
  const histos = new Map();
  const observables = new Map();
  const startMs = now();
  const statsFile = dir ? path.join(dir, 'stats.json') : null;
  let timer = null;

  function loadPersisted() {
    if (!statsFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      for (const c of raw.counters || []) counters.set(attrKey(c.name, c.attrs), { ...c });
      for (const h of raw.histos || []) histos.set(attrKey(h.name, h.attrs), { ...h });
    } catch (e) { /* first run or corrupt, start fresh */ }
  }

  function persist() {
    if (!statsFile) return;
    try {
      fs.mkdirSync(path.dirname(statsFile), { recursive: true });
      fs.writeFileSync(statsFile, JSON.stringify({
        counters: [...counters.values()],
        histos: [...histos.values()],
        gauges: [...gauges.values()],
        updatedMs: now(),
      }, null, 2));
    } catch (e) { /* best effort */ }
  }

  function count(name, attrs = {}, delta = 1) {
    const key = attrKey(name, attrs);
    const cur = counters.get(key) || { name, attrs, value: 0 };
    cur.value += delta;
    counters.set(key, cur);
  }

  function gauge(name, value, attrs = {}) {
    gauges.set(attrKey(name, attrs), { name, attrs, value });
  }

  function record(name, value, attrs = {}) {
    const key = attrKey(name, attrs);
    const h = histos.get(key) || { name, attrs, count: 0, sum: 0, min: value, max: value };
    h.count += 1;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
    histos.set(key, h);
  }

  function registerObservable(name, fn) { observables.set(name, fn); }

  function snapshot() {
    const obs = {};
    for (const [name, fn] of observables) {
      try { obs[name] = fn(); } catch (e) { obs[name] = null; }
    }
    return {
      startMs,
      counters: [...counters.values()].map((c) => ({ ...c })),
      histos: [...histos.values()].map((h) => ({ ...h })),
      gauges: [...gauges.values()].map((g) => ({ ...g })),
      observables: obs,
    };
  }

  function kvAttrs(attrs) {
    return Object.entries(attrs).map(([k, v]) => ({
      key: k,
      value:
        typeof v === 'number'
          ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
          : { stringValue: String(v) },
    }));
  }

  function buildOtlpPayload(snap, nowNano, resourceAttrs = {}) {
    const startNano = String(BigInt(snap.startMs) * 1000000n);
    const tNano = String(nowNano);
    const metrics = [];

    for (const c of snap.counters) {
      metrics.push({
        name: c.name,
        sum: {
          aggregationTemporality: 2, // CUMULATIVE
          isMonotonic: true,
          dataPoints: [{
            asDouble: c.value,
            startTimeUnixNano: startNano,
            timeUnixNano: tNano,
            attributes: kvAttrs(c.attrs),
          }],
        },
      });
    }

    for (const g of snap.gauges) {
      metrics.push({
        name: g.name,
        gauge: { dataPoints: [{ asDouble: g.value, timeUnixNano: tNano, attributes: kvAttrs(g.attrs) }] },
      });
    }

    for (const [name, value] of Object.entries(snap.observables)) {
      if (value == null) continue;
      metrics.push({
        name,
        gauge: { dataPoints: [{ asDouble: value, timeUnixNano: tNano, attributes: [] }] },
      });
    }

    for (const h of snap.histos) {
      metrics.push({
        name: h.name,
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [{
            count: String(h.count),
            sum: h.sum,
            min: h.min,
            max: h.max,
            bucketCounts: [String(h.count)], // single implicit bucket
            explicitBounds: [],
            startTimeUnixNano: startNano,
            timeUnixNano: tNano,
            attributes: kvAttrs(h.attrs),
          }],
        },
      });
    }

    return {
      resourceMetrics: [{
        resource: { attributes: kvAttrs({ 'service.name': 'telegram-gateway', ...resourceAttrs }) },
        scopeMetrics: [{ scope: { name: 'gateway' }, metrics }],
      }],
    };
  }

  function exportOtlp() {
    if (!otlp.enabled || !otlp.endpoint || !otlp.auth) return Promise.resolve({ skipped: true });
    const body = JSON.stringify(buildOtlpPayload(snapshot(), BigInt(now()) * 1000000n, resourceAttrs));
    const url = new URL(otlp.endpoint.replace(/\/$/, '') + '/v1/metrics');
    return new Promise((resolve) => {
      const req = httpsMod.request({
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        port: url.port || 443,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Basic ${otlp.auth}`,
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.setTimeout(otlpTimeoutMs, () => req.destroy(new Error('otlp request timeout')));
      req.write(body);
      req.end();
    });
  }

  async function flush() {
    try { await exportOtlp(); } catch (e) { /* never let telemetry break the gateway */ }
    persist();
  }

  function start() {
    loadPersisted();
    if (!timer) {
      timer = setInterval(() => { flush().catch(() => {}); }, flushIntervalMs);
      if (timer.unref) timer.unref();
    }
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    await flush();
  }

  return {
    count, gauge, record, registerObservable, snapshot,
    buildOtlpPayload, exportOtlp, flush, start, stop, _startMs: startMs,
  };
}

module.exports = { createTelemetry, attrKey };
