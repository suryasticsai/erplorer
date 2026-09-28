/**
 * ERplorer Runner Client — bridge between the static browser app
 * and the local Node service (erplorer-runner) at http://localhost:8787.
 *
 * Loaded AFTER erplorer.js and erplorer-bench.js. Reads the runner URL
 * from window.ERPLORER_CONFIG.runner.baseUrl.
 *
 * Exposes window.ERplorerRunner with:
 *   baseUrl                  — the resolved runner URL
 *   isAvailable()            — alias for checkHealth()
 *   checkHealth()            — probes /health, caches result for 30s
 *   runCurrentRowsViaRunner(opts)  — sends rows from the Lab tab to the runner
 *   startSession(opts)       — begin a new session
 *   runUiSteps(steps, opts)  — execute UI steps via Playwright
 *   runApiCollection(coll, vars)  — execute an API collection
 *   finishSession(status)    — mark complete
 *   promoteSession()         — keep beyond default TTL
 *   askSession(question)     — query the session-scoped RAG
 *   getVideoUrl()            — WebM recording URL for the active session
 *   getFlowUrl()             — flow.md URL for the active session
 *   activeSessionId()        — current session id or null
 *
 * Every call returns a plain object. On failure it returns
 * { ok: false, reason: '...' } and never throws — the caller decides
 * what to do, and the app degrades gracefully when the runner is
 * offline.
 */
(function () {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const CFG = (window.ERPLORER_CONFIG && window.ERPLORER_CONFIG.runner) || {};
  const BASE = String(CFG.baseUrl || 'http://localhost:8787').replace(/\/$/, '');
  const HEALTH_TIMEOUT_MS = 3500;
  const HEALTH_CACHE_MS = 30000;
  const ACTION_TIMEOUT_MS = 180000; // 3 minutes for long actions

  // ============================================================
  // STATE
  // ============================================================
  const STATE = {
    lastHealthCheck: 0,
    lastHealthResult: null,
    activeSessionId: null,
    activeSessionMeta: null
  };

  // ============================================================
  // UTILITIES
  // ============================================================
  function toast(msg, dur) {
    dur = dur || 2400;
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, dur);
  }

  async function fetchJSON(url, options, timeoutMs) {
    timeoutMs = timeoutMs || ACTION_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
        throw new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // HEALTH CHECK
  // ============================================================
  async function checkHealth(force) {
    const now = Date.now();
    if (!force && STATE.lastHealthResult !== null && (now - STATE.lastHealthCheck) < HEALTH_CACHE_MS) {
      return STATE.lastHealthResult;
    }
    try {
      const res = await fetchJSON(BASE + '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
      STATE.lastHealthResult = !!(res && res.ok);
      STATE.lastHealthCheck = now;
      updateRunnerStatusUi();
      return STATE.lastHealthResult;
    } catch (err) {
      STATE.lastHealthResult = false;
      STATE.lastHealthCheck = now;
      updateRunnerStatusUi();
      return false;
    }
  }

  // Alias for code that expects isAvailable() naming
  function isAvailable() {
    return checkHealth();
  }

  // ============================================================
  // STATUS UI — updates the Settings tab's #runner-status element
  // ============================================================
  function updateRunnerStatusUi() {
    const el = document.getElementById('runner-status');
    if (!el) return;
    if (STATE.lastHealthResult === true) {
      el.className = 'status-line ok';
      el.innerHTML = '✅ Connected to runner at <code>' + escapeHtml(BASE) + '</code>';
    } else if (STATE.lastHealthResult === false) {
      el.className = 'status-line warn';
      el.innerHTML = '⚠️ Runner not running. Start it with <code>cd erplorer-runner &amp;&amp; npm start</code> to enable real browser runs and load testing.';
    } else {
      el.className = 'status-line';
      el.textContent = 'Checking runner…';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ============================================================
  // SESSION LIFECYCLE
  // ============================================================
  async function startSession(opts) {
    opts = opts || {};
    if (!(await isAvailable())) return { ok: false, reason: 'runner offline' };
    try {
      const data = await fetchJSON(BASE + '/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts)
      });
      STATE.activeSessionId = data.sessionId;
      STATE.activeSessionMeta = data.meta || null;
      return { ok: true, sessionId: data.sessionId, meta: data.meta };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function finishSession(status) {
    if (!STATE.activeSessionId) return { ok: false, reason: 'no active session' };
    try {
      const data = await fetchJSON(BASE + '/session/' + STATE.activeSessionId + '/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status || 'completed' })
      });
      return { ok: true, meta: data.meta };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function promoteSession() {
    if (!STATE.activeSessionId) return { ok: false, reason: 'no active session' };
    try {
      const data = await fetchJSON(BASE + '/session/' + STATE.activeSessionId + '/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      STATE.activeSessionMeta = data.meta || STATE.activeSessionMeta;
      return { ok: true, meta: data.meta };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function runUiSteps(steps, opts) {
    if (!STATE.activeSessionId) return { ok: false, reason: 'no active session' };
    opts = opts || {};
    try {
      const data = await fetchJSON(BASE + '/session/' + STATE.activeSessionId + '/ui-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: steps,
          headless: opts.headless !== false,
          stopOnError: opts.stopOnError === true
        })
      });
      return Object.assign({ ok: true }, data);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function runApiCollection(collection, vars) {
    if (!STATE.activeSessionId) return { ok: false, reason: 'no active session' };
    try {
      const data = await fetchJSON(BASE + '/session/' + STATE.activeSessionId + '/api-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: collection, vars: vars || {} })
      });
      return Object.assign({ ok: true }, data);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function askSession(question) {
    if (!STATE.activeSessionId) return { ok: false, reason: 'no active session' };
    try {
      const data = await fetchJSON(BASE + '/session/' + STATE.activeSessionId + '/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question })
      });
      return Object.assign({ ok: true }, data);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // ============================================================
  // HIGH-LEVEL: run current Lab rows via the runner
  // ============================================================
  /**
   * Reads the rows currently in the Lab tab (window.ERplorerBench? no —
   * this is the test case table in erplorer.js's Lab panel, exposed via
   * window.ERplorer.getCurrentRows? — we grab from the DOM directly).
   *
   * Splits them into UI steps and API requests, kicks off a runner
   * session, executes both, and finishes the session. Returns a summary.
   */
  async function runCurrentRowsViaRunner(opts) {
    opts = opts || {};

    // Try several sources for the current rows
    let rows = null;
    if (window.ERplorer && typeof window.ERplorer.getCurrentRows === 'function') {
      rows = window.ERplorer.getCurrentRows();
    }
    if (!rows) {
      // Fall back: read from the rendered preview table
      rows = readRowsFromDom();
    }
    if (!rows || !rows.length) {
      return { ok: false, reason: 'no rows to run — generate scenarios first' };
    }

    const runnerOk = await isAvailable();
    if (!runnerOk) {
      toast('Runner offline — start it with: cd erplorer-runner && npm start');
      return { ok: false, reason: 'runner offline' };
    }

    // Split into UI and API steps
    const uiSteps = [];
    const apiRequests = [];
    for (const row of rows) {
      const action = (row.action || '').trim();
      if (['goto', 'fill', 'click', 'expectText', 'expectVisible', 'expectUrl', 'wait'].includes(action)) {
        uiSteps.push({
          action: action,
          selector: row.selector || '',
          value: row.value || '',
          url: row.url || '',
          expected: row.expected || ''
        });
      } else if (['apiRequest', 'expectStatus', 'expectJson', 'expectHeader'].includes(action)) {
        // Group consecutive API actions into a single logical request
        if (action === 'apiRequest') {
          apiRequests.push({
            name: row.scenario || 'API request',
            method: (row.method || 'GET').toUpperCase(),
            url: row.url || '',
            headers: safeJsonParse(row.headers),
            body: safeJsonParse(row.body),
            expectStatus: null,
            expectJson: {}
          });
        } else if (apiRequests.length) {
          const last = apiRequests[apiRequests.length - 1];
          if (action === 'expectStatus') last.expectStatus = Number(row.expected) || null;
          else if (action === 'expectJson' && row.jsonpath) last.expectJson[row.jsonpath] = row.expected;
        }
      }
    }

    if (!uiSteps.length && !apiRequests.length) {
      return { ok: false, reason: 'no runnable steps found' };
    }

    // Start session
    const start = await startSession({
      title: opts.title || 'ERplorer run · ' + new Date().toLocaleString(),
      userStory: opts.userStory || null
    });
    if (!start.ok) return start;

    const summary = { ok: true, sessionId: start.sessionId, ui: null, api: null };

    // Run UI steps
    if (uiSteps.length) {
      const uiResult = await runUiSteps(uiSteps, { headless: opts.headless !== false });
      summary.ui = {
        ok: uiResult.ok,
        stepCount: uiSteps.length,
        errorCount: uiResult.errorCount || 0
      };
    }

    // Run API collection
    if (apiRequests.length) {
      const apiResult = await runApiCollection(
        { requests: apiRequests, stopOnError: opts.stopOnError === true },
        opts.vars || {}
      );
      summary.api = {
        ok: apiResult.ok,
        passCount: apiResult.passCount || 0,
        failCount: apiResult.failCount || 0
      };
    }

    // Finish session
    await finishSession(summary.ui && summary.ui.errorCount > 0 ? 'failed' : 'completed');

    summary.videoUrl = getVideoUrl();
    summary.flowUrl = getFlowUrl();

    return summary;
  }

  function readRowsFromDom() {
    // Fall back: parse the Lab preview table if it exists
    const table = document.querySelector('#ai-preview .data-table');
    if (!table) return null;
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    const rows = [];
    table.querySelectorAll('tbody tr').forEach(tr => {
      const obj = {};
      tr.querySelectorAll('td').forEach((td, i) => {
        obj[headers[i]] = td.textContent.trim();
      });
      rows.push(obj);
    });
    return rows.length ? rows : null;
  }

  function safeJsonParse(str) {
    if (!str) return undefined;
    if (typeof str === 'object') return str;
    try { return JSON.parse(str); } catch (e) { return undefined; }
  }

  // ============================================================
  // ARTIFACT URLs
  // ============================================================
  function getVideoUrl() {
    if (!STATE.activeSessionId) return null;
    return BASE + '/session/' + STATE.activeSessionId + '/video';
  }
  function getFlowUrl() {
    if (!STATE.activeSessionId) return null;
    return BASE + '/session/' + STATE.activeSessionId + '/flow.md';
  }
  function activeSessionId() {
    return STATE.activeSessionId;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  window.ERplorerRunner = {
    baseUrl: BASE,
    isAvailable: isAvailable,
    checkHealth: checkHealth,

    // Lifecycle
    startSession: startSession,
    finishSession: finishSession,
    promoteSession: promoteSession,

    // Execution
    runUiSteps: runUiSteps,
    runApiCollection: runApiCollection,
    runCurrentRowsViaRunner: runCurrentRowsViaRunner,

    // RAG
    askSession: askSession,

    // Artifacts
    getVideoUrl: getVideoUrl,
    getFlowUrl: getFlowUrl,
    activeSessionId: activeSessionId,

    // Diagnostics
    state: function () {
      return {
        baseUrl: BASE,
        lastHealth: STATE.lastHealthResult,
        lastHealthCheck: STATE.lastHealthCheck,
        activeSessionId: STATE.activeSessionId,
        activeSessionMeta: STATE.activeSessionMeta
      };
    }
  };

  // ============================================================
  // BOOT — probe once on load, update the settings card
  // ============================================================
  async function boot() {
    // Give the settings panel time to render
    updateRunnerStatusUi();
    const ok = await checkHealth(true);
    console.log('[erplorer-runner] ' + (ok ? 'connected at ' + BASE : 'not running — spec-generation-only mode'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();