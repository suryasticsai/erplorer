'use strict';
/**
 * Load test engine for the runner.
 *
 * Fires N concurrent requests until the duration elapses, collects
 * latency samples, HTTP status counts, error messages, and byte counts.
 *
 * Node's global fetch (Node 18+) has no 6-connection limit like the
 * browser, so concurrency values of 100+ are real — not capped.
 *
 * Returns the same shape the browser-side bench module produces, so
 * the UI consumes both identically.
 */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function buildHistogram(sorted) {
  if (!sorted.length) return [];
  const buckets = [
    { label: '<10ms',    min: 0,    max: 10 },
    { label: '10-50ms',  min: 10,   max: 50 },
    { label: '50-100ms', min: 50,   max: 100 },
    { label: '100-250ms',min: 100,  max: 250 },
    { label: '250-500ms',min: 250,  max: 500 },
    { label: '500ms-1s', min: 500,  max: 1000 },
    { label: '1-2s',     min: 1000, max: 2000 },
    { label: '2-5s',     min: 2000, max: 5000 },
    { label: '>5s',      min: 5000, max: Infinity }
  ];
  return buckets.map(b => ({
    label: b.label,
    count: sorted.filter(v => v >= b.min && v < b.max).length
  }));
}

async function runLoadTest(opts) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    concurrency = 5,
    durationMs = 10000
  } = opts;

  const stats = {
    total: 0,
    success: 0,
    failed: 0,
    statuses: {},
    errors: {},
    latencies: [],
    bytes: 0,
    startedAt: Date.now(),
    endedAt: 0
  };

  const endTime = stats.startedAt + durationMs;
  const controller = new AbortController();

  async function worker() {
    const isBodyless = method === 'GET' || method === 'HEAD';
    while (Date.now() < endTime && !controller.signal.aborted) {
      const t0 = Date.now();
      stats.total++;
      try {
        const fetchOpts = {
          method,
          headers,
          signal: controller.signal
        };
        if (!isBodyless && body !== undefined && body !== null && body !== '') {
          fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
          // Ensure content-type if not set
          const hasCT = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
          if (!hasCT) {
            fetchOpts.headers = Object.assign({ 'Content-Type': 'application/json' }, headers);
          }
        }

        const res = await fetch(url, fetchOpts);
        const text = await res.text();
        stats.bytes += Buffer.byteLength(text, 'utf-8');

        if (res.ok) stats.success++;
        else stats.failed++;

        stats.statuses[res.status] = (stats.statuses[res.status] || 0) + 1;
        stats.latencies.push(Date.now() - t0);
      } catch (err) {
        if (err.name === 'AbortError') return;
        stats.failed++;
        const key = (err.message || 'unknown error').slice(0, 120);
        stats.errors[key] = (stats.errors[key] || 0) + 1;
        stats.latencies.push(Date.now() - t0);
      }
    }
  }

  // Handle client disconnect — abort the loop
  process.once('SIGINT', () => controller.abort());

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  stats.endedAt = Date.now();

  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const duration = stats.endedAt - stats.startedAt;
  const avg = sorted.length
    ? sorted.reduce((a, b) => a + b, 0) / sorted.length
    : 0;

  return {
    total: stats.total,
    success: stats.success,
    failed: stats.failed,
    durationMs: duration,
    rps: duration > 0 ? (stats.total / (duration / 1000)) : 0,
    bytes: stats.bytes,
    statuses: stats.statuses,
    errors: stats.errors,
    latencies: {
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0,
      avg: avg,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99)
    },
    histogram: buildHistogram(sorted),
    startedAt: new Date(stats.startedAt).toISOString(),
    endedAt: new Date(stats.endedAt).toISOString(),
    runner: true
  };
}

module.exports = { runLoadTest };