// telemetry.js: zero-dependency metrics for the gateway. Built-in `https` only.
// Kept self-contained so this fork stays cleanly mergeable against upstream.
const https = require('https');
const fs = require('fs');
const path = require('path');

function attrKey(name, attrs) {
  const parts = Object.keys(attrs).sort().map((k) => `${k}=${attrs[k]}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

function createTelemetry(opts = {}) {
  const {
    dir = null,
    otlp = {},
    flushIntervalMs = 30000,
    now = () => Date.now(),
    httpsMod = https,
  } = opts;

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

  // Placeholder stubs filled in Task 2.
  function buildOtlpPayload() { return { resourceMetrics: [] }; }
  function exportOtlp() { return Promise.resolve({ skipped: true }); }
  async function flush() { persist(); }
  function start() { loadPersisted(); }
  async function stop() { await flush(); }

  return {
    count, gauge, record, registerObservable, snapshot,
    buildOtlpPayload, exportOtlp, flush, start, stop, _startMs: startMs,
  };
}

module.exports = { createTelemetry, attrKey };
