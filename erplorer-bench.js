/**
 * ERplorer Bench — dummy data + load testing + report exports.
 *
 * Three sub-tabs:
 *   - Dummy Data   : generate realistic rows via Faker (CDN) or fallback generator
 *   - Load Test    : fire N concurrent requests, measure latency + throughput
 *   - Reports      : saved runs from IndexedDB, export as JSON
 *
 * Load test uses the local runner for real concurrency when available;
 * falls back to browser fetch (~6 concurrent, throttled by the browser).
 *
 * Exposes:
 *   window.ERplorerBench.exportLoadReport(fmt)  — 'pdf' | 'json' | 'csv'
 *   window.ERplorerBench.deleteReport(id)
 *   window.ERplorerBench.exportAllReports()
 *   window.ERplorerBench.exportCurrent(fmt)     — current dummy dataset
 *   window.ERplorerBench._setRows(name, rows)   — called by bench-ai
 *   window.ERplorerBench.state()
 */
(function () {
  'use strict';

  // ============================================================
  // STATE
  // ============================================================
  const B = {
    template: 'users',
    rows: [],
    faker: null,
    loadRunning: false,
    loadController: null,
    lastLoadResult: null
  };

  const DB_NAME = 'erplorer_bench';
  const DB_STORE = 'runs';

  // ============================================================
  // UTILITIES
  // ============================================================
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, dur) {
    dur = dur || 2400;
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), dur);
  }

  function downloadFile(name, content, mime) {
    mime = mime || 'text/plain';
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ============================================================
  // INDEXEDDB
  // ============================================================
  function openBenchDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const s = db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'ts');
          s.createIndex('kind', 'kind');
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function saveRun(kind, payload) {
    const db = await openBenchDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const r = tx.objectStore(DB_STORE).add(Object.assign({ kind, ts: Date.now() }, payload));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function listRuns() {
    const db = await openBenchDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).getAll();
      r.onsuccess = () => res(r.result.sort((a, b) => b.ts - a.ts));
      r.onerror = () => rej(r.error);
    });
  }

  async function deleteRun(id) {
    const db = await openBenchDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const r = tx.objectStore(DB_STORE).delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }

  // ============================================================
  // FAKER — CDN load with pure-JS fallback
  // ============================================================
  async function loadFaker() {
    if (B.faker) return B.faker;
    try {
      const mod = await import('https://esm.sh/@faker-js/faker@9');
      B.faker = mod.faker || mod.default || mod;
      return B.faker;
    } catch (err) {
      console.warn('[bench] Faker CDN failed, using built-in generator:', err.message);
      B.faker = makeFallbackFaker();
      return B.faker;
    }
  }

  function makeFallbackFaker() {
    const words = ['alpha','beta','gamma','delta','echo','foxtrot','golf','hotel','india','juliet'];
    const names = ['Alice','Bob','Carol','Dave','Eve','Frank','Grace','Heidi','Ivan','Judy'];
    const cities = ['Mumbai','Bengaluru','Delhi','Chennai','Kolkata','Pune','Hyderabad','Austin','Berlin','Tokyo'];
    const countries = ['IN','US','DE','JP','GB','FR','BR','CA','AU','SG'];

    const rand = arr => arr[Math.floor(Math.random() * arr.length)];
    const num = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });

    return {
      seed: () => {},
      string: {
        uuid,
        alphanumeric: n => Array.from({ length: n || 8 }, () => rand('abcdefghijklmnopqrstuvwxyz0123456789')).join('')
      },
      person: {
        fullName: () => `${rand(names)} ${rand(names)}`,
        firstName: () => rand(names),
        lastName: () => rand(names)
      },
      internet: {
        email: () => `${rand(names).toLowerCase()}.${num(1, 99)}@example.com`
      },
      phone: { number: () => `+91-${num(1000000000, 9999999999)}` },
      location: {
        city: () => rand(cities),
        countryCode: () => rand(countries),
        streetAddress: () => `${num(1, 999)} ${rand(words)} street`
      },
      commerce: {
        productName: () => `${rand(words)} ${rand(words)}`,
        price: () => (Math.random() * 1000).toFixed(2),
        department: () => rand(['Electronics', 'Books', 'Home', 'Toys', 'Clothing'])
      },
      date: { recent: () => new Date(Date.now() - Math.random() * 30 * 864e5).toISOString() },
      number: { int: opts => num((opts && opts.min) || 0, (opts && opts.max) || 100) },
      helpers: { arrayElement: rand }
    };
  }

  // ============================================================
  // TEMPLATES
  // ============================================================
  const TEMPLATES = {
    users: {
      label: 'Users',
      columns: ['id', 'name', 'email', 'phone', 'address', 'city', 'country', 'created_at'],
      generate: f => ({
        id: f.string.uuid(),
        name: f.person.fullName(),
        email: f.internet.email(),
        phone: f.phone.number(),
        address: f.location.streetAddress(),
        city: f.location.city(),
        country: f.location.countryCode(),
        created_at: f.date.recent()
      })
    },
    orders: {
      label: 'Orders',
      columns: ['id', 'user_id', 'product', 'quantity', 'price', 'total', 'status', 'created_at'],
      generate: f => {
        const qty = f.number.int({ min: 1, max: 10 });
        const price = parseFloat(f.commerce.price());
        return {
          id: f.string.uuid(),
          user_id: f.string.uuid(),
          product: f.commerce.productName(),
          quantity: qty,
          price: price,
          total: parseFloat((qty * price).toFixed(2)),
          status: f.helpers.arrayElement(['pending', 'shipped', 'delivered', 'cancelled']),
          created_at: f.date.recent()
        };
      }
    },
    products: {
      label: 'Products',
      columns: ['id', 'name', 'sku', 'price', 'category', 'stock', 'description'],
      generate: f => ({
        id: f.string.uuid(),
        name: f.commerce.productName(),
        sku: f.string.alphanumeric(10).toUpperCase(),
        price: parseFloat(f.commerce.price()),
        category: f.commerce.department(),
        stock: f.number.int({ min: 0, max: 1000 }),
        description: f.commerce.productName() + ' — premium quality'
      })
    },
    events: {
      label: 'Events',
      columns: ['id', 'type', 'user_id', 'timestamp', 'properties'],
      generate: f => ({
        id: f.string.uuid(),
        type: f.helpers.arrayElement(['page_view', 'click', 'signup', 'purchase', 'logout']),
        user_id: f.string.uuid(),
        timestamp: f.date.recent(),
        properties: JSON.stringify({
          device: f.helpers.arrayElement(['mobile', 'desktop']),
          country: f.location.countryCode()
        })
      })
    },
    transactions: {
      label: 'Transactions',
      columns: ['id', 'from_account', 'to_account', 'amount', 'currency', 'status', 'timestamp'],
      generate: f => ({
        id: f.string.uuid(),
        from_account: f.string.alphanumeric(12).toUpperCase(),
        to_account: f.string.alphanumeric(12).toUpperCase(),
        amount: parseFloat((Math.random() * 5000).toFixed(2)),
        currency: f.helpers.arrayElement(['USD', 'EUR', 'INR', 'GBP']),
        status: f.helpers.arrayElement(['completed', 'pending', 'failed']),
        timestamp: f.date.recent()
      })
    }
  };

  // ============================================================
  // DATA GENERATION
  // ============================================================
  async function generateRows(templateKey, count, seed) {
    const tpl = TEMPLATES[templateKey];
    if (!tpl) throw new Error('unknown template: ' + templateKey);
    const faker = await loadFaker();
    if (seed) faker.seed(seed);
    const out = [];
    for (let i = 0; i < count; i++) out.push(tpl.generate(faker, i));
    return out;
  }

  function renderDataPreview() {
    const el = document.getElementById('bench-data-preview');
    if (!el) return;
    if (!B.rows.length) {
      el.innerHTML = '<div class="empty">No data yet. Pick a template and click Generate.</div>';
      return;
    }
    const cols = Object.keys(B.rows[0]);
    const preview = B.rows.slice(0, 20);
    el.innerHTML = `
      <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">
        Showing 20 of ${B.rows.length} rows · ${cols.length} columns
      </div>
      <div style="overflow-x:auto; border-radius:var(--radius);">
        <table class="data-table">
          <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${preview.map(r => `<tr>${cols.map(c => `<td>${esc(String(r[c]).slice(0, 40))}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ============================================================
  // DATA EXPORT
  // ============================================================
  function exportData(format) {
    if (!B.rows.length) { toast('No data to export'); return; }
    const cols = Object.keys(B.rows[0]);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    if (format === 'csv') {
      const csvEsc = v => {
        const s = String(v == null ? '' : v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      };
      const body = [cols.join(','), ...B.rows.map(r => cols.map(c => csvEsc(r[c])).join(','))].join('\n');
      downloadFile(`dummy-${B.template}-${ts}.csv`, body, 'text/csv');
      toast('📄 CSV downloaded');
      return;
    }

    if (format === 'json') {
      downloadFile(`dummy-${B.template}-${ts}.json`, JSON.stringify(B.rows, null, 2), 'application/json');
      toast('📄 JSON downloaded');
      return;
    }

    if (format === 'sql') {
      const escapeSql = v => {
        if (v == null) return 'NULL';
        if (typeof v === 'number') return v;
        return "'" + String(v).replace(/'/g, "''") + "'";
      };
      const table = B.template;
      const sql = [
        `-- Dummy data — ${B.rows.length} rows`,
        `-- Generated ${new Date().toISOString()}`,
        '',
        ...B.rows.map(r =>
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => escapeSql(r[c])).join(', ')});`
        )
      ].join('\n');
      downloadFile(`dummy-${table}-${ts}.sql`, sql, 'application/sql');
      toast('📄 SQL downloaded');
      return;
    }

    if (format === 'xlsx') {
      if (typeof XLSX === 'undefined') { toast('⚠️ XLSX library not loaded'); return; }
      const aoa = [cols, ...B.rows.map(r => cols.map(c => String(r[c] == null ? '' : r[c])))];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, B.template);
      XLSX.writeFile(wb, `dummy-${B.template}-${ts}.xlsx`);
      toast('📄 XLSX downloaded');
    }
  }

  // ============================================================
  // LOAD TEST — STATS
  // ============================================================
  function emptyStats() {
    return {
      total: 0, success: 0, failed: 0,
      statuses: {}, errors: {},
      latencies: [],
      startedAt: 0, endedAt: 0,
      bytes: 0
    };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  function buildHistogram(sorted) {
    if (!sorted.length) return [];
    const buckets = [
      { label: '<10ms', min: 0, max: 10 },
      { label: '10-50ms', min: 10, max: 50 },
      { label: '50-100ms', min: 50, max: 100 },
      { label: '100-250ms', min: 100, max: 250 },
      { label: '250-500ms', min: 250, max: 500 },
      { label: '500ms-1s', min: 500, max: 1000 },
      { label: '1-2s', min: 1000, max: 2000 },
      { label: '2-5s', min: 2000, max: 5000 },
      { label: '>5s', min: 5000, max: Infinity }
    ];
    return buckets.map(b => ({
      label: b.label,
      count: sorted.filter(v => v >= b.min && v < b.max).length
    }));
  }

  function computeFinalStats(s) {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const durationMs = s.endedAt - s.startedAt;
    return {
      total: s.total,
      success: s.success,
      failed: s.failed,
      durationMs: durationMs,
      rps: durationMs > 0 ? (s.total / (durationMs / 1000)) : 0,
      bytes: s.bytes,
      statuses: Object.assign({}, s.statuses),
      errors: Object.assign({}, s.errors),
      latencies: {
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0,
        avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99)
      },
      histogram: buildHistogram(sorted),
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.endedAt).toISOString()
    };
  }

  // ============================================================
  // LOAD TEST — RUNNER CHECK
  // ============================================================
  async function runnerIsAvailable() {
    if (!window.ERplorerRunner) return false;
    const fn = window.ERplorerRunner.isAvailable || window.ERplorerRunner.checkHealth;
    if (typeof fn !== 'function') return false;
    try {
      const r = await fn.call(window.ERplorerRunner);
      return !!r;
    } catch (e) {
      return false;
    }
  }

  function runnerBaseUrl() {
    return (window.ERPLORER_CONFIG && window.ERPLORER_CONFIG.runner && window.ERPLORER_CONFIG.runner.baseUrl)
      || 'http://localhost:8787';
  }

  // ============================================================
  // LOAD TEST — BROWSER MODE
  // ============================================================
  async function runBrowserLoadTest(opts) {
    const url = opts.url, method = opts.method, headers = opts.headers, body = opts.body;
    const concurrency = opts.concurrency, durationMs = opts.durationMs;

    const s = emptyStats();
    s.startedAt = performance.now();
    const endTime = s.startedAt + durationMs;

    async function worker() {
      while (performance.now() < endTime && !B.loadController.signal.aborted) {
        const t0 = performance.now();
        s.total++;
        try {
          const res = await fetch(url, {
            method: method,
            headers: headers,
            body: (method === 'GET' || method === 'HEAD') ? undefined : body,
            signal: B.loadController.signal
          });
          const text = await res.text();
          s.bytes += text.length;
          if (res.ok) s.success++; else s.failed++;
          s.statuses[res.status] = (s.statuses[res.status] || 0) + 1;
          s.latencies.push(performance.now() - t0);
        } catch (err) {
          if (err.name === 'AbortError') return;
          s.failed++;
          const key = err.message || 'unknown error';
          s.errors[key] = (s.errors[key] || 0) + 1;
          s.latencies.push(performance.now() - t0);
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, 50); i++) workers.push(worker());

    const progressInterval = setInterval(() => renderLiveStats(s), 500);
    await Promise.all(workers);
    clearInterval(progressInterval);

    s.endedAt = performance.now();
    return computeFinalStats(s);
  }

  // ============================================================
  // LOAD TEST — RUNNER MODE
  // ============================================================
  async function runRunnerLoadTest(opts) {
    const res = await fetch(runnerBaseUrl() + '/bench/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    });
    if (!res.ok) throw new Error('runner returned HTTP ' + res.status);
    return await res.json();
  }

  // ============================================================
  // LOAD TEST — ORCHESTRATOR
  // ============================================================
  async function startLoadTest() {
    if (B.loadRunning) { toast('Already running'); return; }

    const url = document.getElementById('bench-load-url').value.trim();
    if (!url) { toast('Enter a URL'); return; }

    const method = document.getElementById('bench-load-method').value;
    const concurrency = parseInt(document.getElementById('bench-load-concurrency').value, 10) || 5;
    const durationSec = parseInt(document.getElementById('bench-load-duration').value, 10) || 10;

    let headers = {};
    let body = '';
    try {
      const headersText = document.getElementById('bench-load-headers').value.trim();
      if (headersText) headers = JSON.parse(headersText);
    } catch (e) { toast('Headers must be valid JSON'); return; }
    body = document.getElementById('bench-load-body').value.trim();

    const opts = {
      url: url,
      method: method,
      headers: headers,
      body: body,
      concurrency: concurrency,
      durationMs: durationSec * 1000
    };

    B.loadRunning = true;
    B.loadController = new AbortController();
    const runBtn = document.getElementById('bench-load-run');
    const stopBtn = document.getElementById('bench-load-stop');
    const statusEl = document.getElementById('bench-load-status');
    if (runBtn) runBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'status-line';
      statusEl.textContent = `Running ${concurrency} concurrent ${method} requests for ${durationSec}s…`;
    }

    const useRunnerCheckbox = document.getElementById('bench-use-runner');
    const wantRunner = useRunnerCheckbox && useRunnerCheckbox.checked;
    const runnerAvailable = await runnerIsAvailable();

    let result = null;
    let usedRunner = false;

    if (wantRunner && runnerAvailable) {
      if (statusEl) statusEl.textContent = `Running via runner (real concurrency) for ${durationSec}s…`;
      try {
        result = await runRunnerLoadTest(opts);
        usedRunner = true;
      } catch (err) {
        console.warn('[bench] runner failed, falling back to browser:', err.message);
        if (statusEl) statusEl.textContent = `Runner failed (${err.message}). Falling back to browser mode…`;
        try {
          result = await runBrowserLoadTest(opts);
        } catch (err2) {
          toast('Load test failed: ' + err2.message);
          B.loadRunning = false;
          if (runBtn) runBtn.disabled = false;
          if (stopBtn) stopBtn.disabled = true;
          return;
        }
      }
    } else {
      try {
        result = await runBrowserLoadTest(opts);
      } catch (err) {
        toast('Load test failed: ' + err.message);
        B.loadRunning = false;
        if (runBtn) runBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        return;
      }
    }

    B.loadRunning = false;
    B.lastLoadResult = Object.assign({}, result, {
      url: url, method: method, concurrency: concurrency, runner: usedRunner
    });

    if (runBtn) runBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (statusEl) {
      statusEl.className = 'status-line ok';
      statusEl.textContent = `Done · ${result.total} requests in ${(result.durationMs / 1000).toFixed(1)}s · ${usedRunner ? 'runner' : 'browser'} mode`;
    }

    renderLoadResults(B.lastLoadResult);
    saveRun('load', B.lastLoadResult).catch(() => {});

    if (window.ERplorerBenchAI && typeof window.ERplorerBenchAI.setLastResult === 'function') {
      window.ERplorerBenchAI.setLastResult(B.lastLoadResult);
    }
  }

  function stopLoadTest() {
    if (!B.loadRunning) return;
    if (B.loadController) B.loadController.abort();
    B.loadRunning = false;
    const runBtn = document.getElementById('bench-load-run');
    const stopBtn = document.getElementById('bench-load-stop');
    const statusEl = document.getElementById('bench-load-status');
    if (runBtn) runBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Stopped.';
  }

  function renderLiveStats(s) {
    const el = document.getElementById('bench-load-live');
    if (!el) return;
    const elapsed = (performance.now() - s.startedAt) / 1000;
    const rps = elapsed > 0 ? (s.total / elapsed) : 0;
    el.innerHTML = `
      <div class="live-grid">
        <div><strong>${s.total}</strong><span>requests</span></div>
        <div><strong>${s.success}</strong><span>success</span></div>
        <div><strong>${s.failed}</strong><span>failed</span></div>
        <div><strong>${rps.toFixed(1)}</strong><span>req/s</span></div>
      </div>
    `;
  }

  function renderLoadResults(r) {
    const el = document.getElementById('bench-load-results');
    if (!el) return;

    const histogram = r.histogram.map(b => {
      const pct = r.total ? (b.count / r.total) * 100 : 0;
      return `
        <div class="hist-row">
          <div class="hist-label">${esc(b.label)}</div>
          <div class="hist-bar-track"><div class="hist-bar" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="hist-count">${b.count}</div>
        </div>
      `;
    }).join('');

    const statusRows = Object.entries(r.statuses)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => {
        const cls = code < 300 ? 'ok' : code < 400 ? 'warn' : 'err';
        return `<span class="status-pill status-${cls}">${code}: ${count}</span>`;
      }).join('');

    const errorRows = Object.entries(r.errors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([msg, count]) =>
        `<div class="error-row"><span class="error-count">×${count}</span> <code>${esc(msg.slice(0, 80))}</code></div>`
      ).join('');

    el.innerHTML = `
      <div class="insights-grid">
        <div class="insights-card">
          <div class="card-title">Performance summary</div>
          <div style="margin-top:14px;">
            <div class="metric-row"><span>Total requests</span><strong>${r.total}</strong></div>
            <div class="metric-row"><span>Success</span><strong style="color:#16A34A">${r.success}</strong></div>
            <div class="metric-row"><span>Failed</span><strong style="color:#DC2626">${r.failed}</strong></div>
            <div class="metric-row"><span>Duration</span><strong>${(r.durationMs / 1000).toFixed(2)}s</strong></div>
            <div class="metric-row"><span>Throughput</span><strong>${r.rps.toFixed(1)} req/s</strong></div>
            <div class="metric-row"><span>Bytes received</span><strong>${(r.bytes / 1024).toFixed(1)} KB</strong></div>
            <div class="metric-row"><span>Mode</span><strong>${r.runner ? 'runner' : 'browser'}</strong></div>
          </div>
        </div>
        <div class="insights-card">
          <div class="card-title">Latency</div>
          <div style="margin-top:14px;">
            <div class="metric-row"><span>Min</span><strong>${r.latencies.min.toFixed(1)} ms</strong></div>
            <div class="metric-row"><span>Avg</span><strong>${r.latencies.avg.toFixed(1)} ms</strong></div>
            <div class="metric-row"><span>p50</span><strong>${r.latencies.p50.toFixed(1)} ms</strong></div>
            <div class="metric-row"><span>p90</span><strong>${r.latencies.p90.toFixed(1)} ms</strong></div>
            <div class="metric-row"><span>p95</span><strong>${r.latencies.p95.toFixed(1)} ms</strong></div>
            <div class="metric-row"><span>p99</span><strong>${r.latencies.p99.toFixed(1)} ms</strong></div>
            <div class="metric-row"><span>Max</span><strong>${r.latencies.max.toFixed(1)} ms</strong></div>
          </div>
        </div>
      </div>

      <div class="insights-grid">
        <div class="insights-card" style="grid-column: 1 / -1;">
          <div class="card-title">Latency distribution</div>
          <div class="card-desc">How many requests landed in each latency bucket.</div>
          <div style="margin-top:14px;">${histogram}</div>
        </div>
      </div>

      ${statusRows ? `
      <div class="insights-card" style="margin-bottom:12px;">
        <div class="card-title">HTTP status breakdown</div>
        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">${statusRows}</div>
      </div>` : ''}

      ${errorRows ? `
      <div class="insights-card" style="margin-bottom:12px;">
        <div class="card-title">Errors</div>
        <div style="margin-top:12px;">${errorRows}</div>
      </div>` : ''}

      <div class="row" style="margin-top:14px;">
        <button class="btn secondary" onclick="ERplorerBench.exportLoadReport('pdf')">📄 Export PDF</button>
        <button class="btn secondary" onclick="ERplorerBench.exportLoadReport('json')">📄 Export JSON</button>
        <button class="btn secondary" onclick="ERplorerBench.exportLoadReport('csv')">📄 Export CSV</button>
      </div>
    `;
  }

  // ============================================================
  // REPORT EXPORTS
  // ============================================================
  async function exportLoadReport(format) {
    const r = B.lastLoadResult;
    if (!r) { toast('No load test to export'); return; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    if (format === 'json') {
      downloadFile(`load-test-${ts}.json`, JSON.stringify(r, null, 2), 'application/json');
      toast('📄 JSON downloaded');
      return;
    }

    if (format === 'csv') {
      const rows = [
        ['metric', 'value'],
        ['url', r.url],
        ['method', r.method],
        ['concurrency', r.concurrency],
        ['mode', r.runner ? 'runner' : 'browser'],
        ['total', r.total],
        ['success', r.success],
        ['failed', r.failed],
        ['duration_ms', r.durationMs.toFixed(2)],
        ['rps', r.rps.toFixed(2)],
        ['latency_min', r.latencies.min.toFixed(2)],
        ['latency_avg', r.latencies.avg.toFixed(2)],
        ['latency_p50', r.latencies.p50.toFixed(2)],
        ['latency_p90', r.latencies.p90.toFixed(2)],
        ['latency_p95', r.latencies.p95.toFixed(2)],
        ['latency_p99', r.latencies.p99.toFixed(2)],
        ['latency_max', r.latencies.max.toFixed(2)]
      ];
      const csv = rows.map(row => row.map(v => {
        const s = String(v == null ? '' : v);
        return (s.includes(',') || s.includes('"'))
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      }).join(',')).join('\n');
      downloadFile(`load-test-${ts}.csv`, csv, 'text/csv');
      toast('📄 CSV downloaded');
      return;
    }

    if (format === 'pdf') {
      try {
        const cdn = (window.ERPLORER_CONFIG && window.ERPLORER_CONFIG.cdn && window.ERPLORER_CONFIG.cdn.jspdf)
          || 'https://esm.sh/jspdf@2.5.1';
        const mod = await import(cdn);
        const jsPDF = mod.jsPDF || mod.default;
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const margin = 40;
        let y = 60;

        doc.setFontSize(20); doc.setFont(undefined, 'bold');
        doc.text('ERplorer Load Test Report', margin, y); y += 26;
        doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(120);
        doc.text('Generated ' + new Date().toLocaleString(), margin, y); y += 22;
        doc.setTextColor(0);

        doc.setFontSize(11); doc.setFont(undefined, 'bold');
        doc.text('Target', margin, y); y += 16;
        doc.setFont(undefined, 'normal'); doc.setFontSize(10);
        doc.text('URL:          ' + r.url, margin, y); y += 14;
        doc.text('Method:       ' + r.method, margin, y); y += 14;
        doc.text('Concurrency:  ' + r.concurrency, margin, y); y += 14;
        doc.text('Duration:     ' + (r.durationMs / 1000).toFixed(2) + 's', margin, y); y += 14;
        doc.text('Mode:         ' + (r.runner ? 'runner' : 'browser'), margin, y); y += 20;

        doc.setFont(undefined, 'bold'); doc.setFontSize(11);
        doc.text('Results', margin, y); y += 16;
        doc.setFont(undefined, 'normal'); doc.setFontSize(10);
        doc.text('Total requests:   ' + r.total, margin, y); y += 14;
        doc.text('Success:          ' + r.success, margin, y); y += 14;
        doc.text('Failed:           ' + r.failed, margin, y); y += 14;
        doc.text('Throughput:       ' + r.rps.toFixed(1) + ' req/s', margin, y); y += 20;

        doc.setFont(undefined, 'bold'); doc.setFontSize(11);
        doc.text('Latency (ms)', margin, y); y += 16;
        doc.setFont(undefined, 'normal'); doc.setFontSize(10);
        doc.text('Min / Avg / Max:  ' + r.latencies.min.toFixed(1) + ' / ' + r.latencies.avg.toFixed(1) + ' / ' + r.latencies.max.toFixed(1), margin, y); y += 14;
        doc.text('p50 / p90:        ' + r.latencies.p50.toFixed(1) + ' / ' + r.latencies.p90.toFixed(1), margin, y); y += 14;
        doc.text('p95 / p99:        ' + r.latencies.p95.toFixed(1) + ' / ' + r.latencies.p99.toFixed(1), margin, y); y += 20;

        doc.setFont(undefined, 'bold'); doc.setFontSize(11);
        doc.text('Histogram', margin, y); y += 16;
        doc.setFont(undefined, 'normal'); doc.setFontSize(9);
        const barMax = Math.max.apply(null, r.histogram.map(h => h.count).concat([1]));
        for (const h of r.histogram) {
          if (y > 780) { doc.addPage(); y = 60; }
          const barLen = Math.round((h.count / barMax) * 240);
          doc.text(h.label.padEnd(12), margin, y);
          doc.setFillColor(30, 64, 175);
          doc.rect(margin + 80, y - 8, barLen, 10, 'F');
          doc.text(String(h.count), margin + 80 + barLen + 6, y);
          y += 14;
        }

        if (Object.keys(r.statuses).length) {
          y += 10;
          doc.setFont(undefined, 'bold'); doc.setFontSize(11);
          doc.text('HTTP status breakdown', margin, y); y += 16;
          doc.setFont(undefined, 'normal'); doc.setFontSize(10);
          for (const code of Object.keys(r.statuses)) {
            doc.text(code + ': ' + r.statuses[code], margin, y); y += 14;
          }
        }

        doc.save('load-test-' + ts + '.pdf');
        toast('📄 PDF downloaded');
      } catch (err) {
        toast('⚠️ PDF failed: ' + err.message);
      }
    }
  }

  // ============================================================
  // REPORTS LIST
  // ============================================================
  async function renderReportsList() {
    const el = document.getElementById('bench-reports-list');
    if (!el) return;
    const runs = await listRuns();
    if (!runs.length) {
      el.innerHTML = '<div class="empty">No saved runs yet. Load tests are saved automatically.</div>';
      return;
    }
    el.innerHTML = runs.map(r => {
      const when = new Date(r.ts).toLocaleString();
      const summary = r.kind === 'load'
        ? `${r.total} req · ${r.rps.toFixed(1)} req/s · p95 ${r.latencies.p95.toFixed(0)}ms`
        : `${(r.rows || []).length} rows`;
      return `
        <div class="report-row">
          <div class="report-kind">${esc(r.kind)}</div>
          <div class="report-summary">${esc(summary)}</div>
          <div class="report-when">${esc(when)}</div>
          <button class="report-delete" onclick="ERplorerBench.deleteReport(${r.id})" title="Delete">✕</button>
        </div>
      `;
    }).join('');
  }

  async function deleteReport(id) {
    await deleteRun(id);
    renderReportsList();
  }

  async function exportAllReports() {
    const runs = await listRuns();
    if (!runs.length) { toast('No reports to export'); return; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bundle = {
      exportedAt: new Date().toISOString(),
      count: runs.length,
      runs: runs
    };
    downloadFile('erplorer-reports-' + ts + '.json', JSON.stringify(bundle, null, 2), 'application/json');
    toast('📄 Exported ' + runs.length + ' report(s)');
  }

  // ============================================================
  // UI WIRING
  // ============================================================
  function initSubTabs() {
    document.querySelectorAll('.subtab[data-bench]').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.subtab[data-bench]').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        ['data', 'load', 'reports'].forEach(key => {
          const el = document.getElementById('bench-' + key);
          if (el) el.style.display = t.dataset.bench === key ? 'block' : 'none';
        });
        if (t.dataset.bench === 'reports') renderReportsList();
      });
    });
  }

  function initDataTab() {
    const tplSelect = document.getElementById('bench-template');
    if (tplSelect) {
      tplSelect.innerHTML = Object.keys(TEMPLATES).map(k =>
        `<option value="${k}">${esc(TEMPLATES[k].label)}</option>`
      ).join('');
    }

    const genBtn = document.getElementById('bench-generate');
    if (genBtn) {
      genBtn.addEventListener('click', async () => {
        const template = document.getElementById('bench-template').value;
        const count = parseInt(document.getElementById('bench-count').value, 10) || 100;
        const seed = parseInt(document.getElementById('bench-seed').value, 10) || 0;
        if (count > 50000) { toast('Capped at 50,000 rows'); return; }
        genBtn.disabled = true;
        genBtn.textContent = 'Generating…';
        try {
          B.template = template;
          B.rows = await generateRows(template, count, seed);
          renderDataPreview();
          toast('✅ ' + B.rows.length + ' rows generated');
        } catch (err) {
          toast('Generation failed: ' + err.message);
        } finally {
          genBtn.disabled = false;
          genBtn.textContent = 'Generate';
        }
      });
    }

    document.querySelectorAll('[data-bench-export]').forEach(btn => {
      btn.addEventListener('click', () => exportData(btn.dataset.benchExport));
    });
  }

  function initLoadTab() {
    const run = document.getElementById('bench-load-run');
    const stop = document.getElementById('bench-load-stop');
    if (run) run.addEventListener('click', startLoadTest);
    if (stop) stop.addEventListener('click', stopLoadTest);

    (async () => {
      const el = document.getElementById('bench-runner-note');
      if (!el) return;
      const ok = await runnerIsAvailable();
      const checkbox = document.getElementById('bench-use-runner');
      if (ok) {
        el.innerHTML = '✅ Runner is available — check the box above to test with real concurrency (unlimited).';
        if (checkbox) { checkbox.disabled = false; checkbox.checked = true; }
      } else {
        el.innerHTML = '⚠️ Runner not running — browser mode caps at ~6 concurrent requests. Start the runner with <code>cd erplorer-runner &amp;&amp; npm start</code> for real numbers.';
        if (checkbox) { checkbox.disabled = true; checkbox.checked = false; }
      }
    })();
  }

  // ============================================================
  // PUBLIC HELPERS FOR AI BRIDGE
  // ============================================================
  function _setRows(template, rows) {
    B.template = template || 'ai';
    B.rows = rows;
    renderDataPreview();
  }

  function exportCurrent(format) {
    exportData(format);
  }

  // ============================================================
  // BOOT
  // ============================================================
  function boot() {
    initSubTabs();
    initDataTab();
    initLoadTab();
    renderDataPreview();
    renderReportsList();
  }

  window.ERplorerBench = {
    exportLoadReport: exportLoadReport,
    deleteReport: deleteReport,
    exportAllReports: exportAllReports,
    exportCurrent: exportCurrent,
    _setRows: _setRows,
    generate: generateRows,
    state: function () {
      return {
        rows: B.rows.length,
        template: B.template,
        running: B.loadRunning,
        lastResult: B.lastLoadResult
      };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();