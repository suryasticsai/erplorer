/**
 * erplorer-runner-client.js
 *
 * Bridges the static ERplorer app to the local erplorer-runner Node
 * service (Playwright + Postman-style requests + session RAG).
 *
 * Reads its target from window.ERPLORER_CONFIG.runner.baseUrl
 * (set in erplorer.config.js). If that's missing, or the runner is
 * unreachable, this script disables itself quietly — it never blocks
 * or breaks the rest of the app, since the runner is optional local
 * infrastructure, not something every visitor will have running.
 *
 * Adds:
 *   - a "Run via Runner" button next to the existing Lab "Generate
 *     specs" flow, which starts a session, executes the UI + API
 *     steps for real, and shows the resulting video + an ask box
 *   - ERplorerRunner.* helper functions for other UI to call
 */
(function () {
  'use strict';

  const RUNNER_CFG = (window.ERPLORER_CONFIG || {}).runner || {};
  const BASE_URL = (RUNNER_CFG.baseUrl || '').replace(/\/$/, '');

  if (!BASE_URL) {
    console.log('[erplorer-runner-client] no runner.baseUrl configured — skipping.');
    return;
  }

  let runnerAvailable = false;

  async function checkHealth() {
    try {
      const res = await fetch(BASE_URL + '/health', { method: 'GET' });
      runnerAvailable = res.ok;
    } catch (e) {
      runnerAvailable = false;
    }
    return runnerAvailable;
  }

  async function api(path, opts) {
    const res = await fetch(BASE_URL + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts));
    if (!res.ok) {
      let msg = res.statusText;
      try { const d = await res.json(); if (d.error) msg = d.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  // ------------------------------------------------------------
  // Splitting the Lab tab's currentRows (id/scenario/step/action/...)
  // into UI steps vs API requests, same categorization erplorer.js
  // already uses for Playwright vs pytest generation.
  // ------------------------------------------------------------
  const UI_ACTIONS = new Set(['goto', 'fill', 'click', 'expectText', 'expectVisible', 'expectUrl', 'wait']);
  const API_ACTIONS = new Set(['apiRequest', 'expectStatus', 'expectJson', 'expectHeader']);

  function rowsToUiSteps(rows) {
    return rows.filter(r => UI_ACTIONS.has(r.action)).map(r => ({
      action: r.action, selector: r.selector, value: r.value, url: r.url, expected: r.expected
    }));
  }

  /**
   * Rows come out of the Lab tab as a flat step list, but the runner's
   * API collection wants request objects (one apiRequest + its trailing
   * expectStatus/expectJson/expectHeader rows folded together). This
   * folds sequential rows per test case into that shape.
   */
  function rowsToApiCollection(rows) {
    const requests = [];
    let current = null;
    for (const r of rows) {
      if (!API_ACTIONS.has(r.action)) continue;
      if (r.action === 'apiRequest') {
        current = { name: r.id + ':' + r.step, method: r.method || 'GET', url: r.url, headers: safeJson(r.headers), body: safeJson(r.body) };
        requests.push(current);
      } else if (current) {
        if (r.action === 'expectStatus') current.expectStatus = Number(r.expected);
        if (r.action === 'expectJson') {
          current.expectJson = current.expectJson || {};
          if (r.jsonpath) current.expectJson[r.jsonpath] = r.expected;
        }
      }
    }
    return { requests };
  }

  function safeJson(v) {
    if (!v) return undefined;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return undefined; }
  }

  // ------------------------------------------------------------
  // Run a whole Lab scenario set through the runner and render
  // the result (video link, flow doc link, ask box) into the DOM.
  // ------------------------------------------------------------
  async function runCurrentRowsViaRunner() {
    const rows = (window.ERplorer && window.ERplorer.state && window.ERplorer.state().currentRows) || window._erplorerCurrentRows;
    const targetEl = document.getElementById('gen-output') || document.getElementById('ai-preview');
    if (!rows || !rows.length) {
      if (targetEl) targetEl.insertAdjacentHTML('afterbegin', runnerStatusHtml('err', 'No generated rows to run. Convert scenarios first.'));
      return;
    }
    if (!(await checkHealth())) {
      if (targetEl) targetEl.insertAdjacentHTML('afterbegin', runnerStatusHtml('err', 'Runner not reachable at ' + BASE_URL + '. Is `npm start` running?'));
      return;
    }

    if (targetEl) targetEl.insertAdjacentHTML('afterbegin', runnerStatusHtml('info', 'Starting session…', 'runner-live-status'));
    const setStatus = (kind, html) => {
      const el = document.getElementById('runner-live-status');
      if (el) el.outerHTML = runnerStatusHtml(kind, html, 'runner-live-status');
    };

    try {
      const testCaseId = rows[0].id || 'session';
      const { sessionId } = await api('/session/start', {
        method: 'POST',
        body: JSON.stringify({ title: testCaseId, userStory: rows[0].scenario || null })
      });

      const uiSteps = rowsToUiSteps(rows);
      const apiCollection = rowsToApiCollection(rows);

      if (uiSteps.length) {
        setStatus('info', `Running ${uiSteps.length} browser step(s)…`);
        await api(`/session/${sessionId}/ui-run`, { method: 'POST', body: JSON.stringify({ steps: uiSteps, headless: true }) });
      }
      if (apiCollection.requests.length) {
        setStatus('info', `Running ${apiCollection.requests.length} API request(s)…`);
        await api(`/session/${sessionId}/api-run`, { method: 'POST', body: JSON.stringify({ collection: apiCollection }) });
      }

      await api(`/session/${sessionId}/finish`, { method: 'POST' });

      setStatus('ok', renderSessionResultHtml(sessionId));
      wireAskBox(sessionId);
    } catch (e) {
      setStatus('err', 'Run failed: ' + escapeHtml(e.message));
    }
  }

  function renderSessionResultHtml(sessionId) {
    return `
      Run complete.
      <div class="row" style="margin-top:10px; flex-wrap:wrap;">
        <a class="btn secondary" href="${BASE_URL}/session/${sessionId}/video" target="_blank" style="font-size:12px; padding:8px 14px;">▶ View recording</a>
        <a class="btn secondary" href="${BASE_URL}/session/${sessionId}/flow.md" target="_blank" style="font-size:12px; padding:8px 14px;">📄 Flow doc</a>
        <button class="btn secondary" onclick="ERplorerRunner.promoteSession('${sessionId}')" style="font-size:12px; padding:8px 14px;">📌 Keep permanently</button>
      </div>
      <div style="margin-top:12px;">
        <input type="text" class="input" id="runner-ask-input-${sessionId}" placeholder="Ask about this run — e.g. 'why did step 3 fail?'" style="margin-bottom:8px;">
        <button class="btn" id="runner-ask-btn-${sessionId}" style="font-size:12px; padding:8px 14px;">Ask</button>
        <div id="runner-ask-answer-${sessionId}" style="margin-top:10px; font-size:13px; color:var(--ink-2);"></div>
      </div>
    `;
  }

  function wireAskBox(sessionId) {
    const btn = document.getElementById('runner-ask-btn-' + sessionId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const input = document.getElementById('runner-ask-input-' + sessionId);
      const out = document.getElementById('runner-ask-answer-' + sessionId);
      const q = input ? input.value.trim() : '';
      if (!q || !out) return;
      out.textContent = 'Thinking…';
      try {
        const { answer } = await api(`/session/${sessionId}/ask`, { method: 'POST', body: JSON.stringify({ question: q }) });
        out.textContent = answer;
      } catch (e) {
        out.textContent = 'Error: ' + e.message;
      }
    });
  }

  async function promoteSession(sessionId) {
    try {
      await api(`/session/${sessionId}/promote`, { method: 'POST' });
      if (window.ERplorer && typeof window.ERplorer.state === 'function') {
        // no direct toast hook exposed publicly; fall back to alert-free no-op
      }
      console.log('[erplorer-runner-client] session promoted:', sessionId);
    } catch (e) {
      console.warn('[erplorer-runner-client] promote failed:', e.message);
    }
  }

  function runnerStatusHtml(kind, html, id) {
    const cls = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
    return `<div class="status-line ${cls}"${id ? ` id="${id}"` : ''}>${html}</div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------
  // Inject a "Run via Runner" button next to the existing
  // "Generate specs" button in the Lab tab, once the DOM is ready.
  // ------------------------------------------------------------
  function injectButton() {
    // The button lives inside the dynamically-rendered scenario table
    // (see renderScenarioTable in erplorer.js), so we watch for it.
    const observer = new MutationObserver(() => {
      const genBtn = document.querySelector('#ai-preview button[onclick="ERplorer.generateFromRows()"]');
      if (genBtn && !document.getElementById('runner-run-btn')) {
        const btn = document.createElement('button');
        btn.id = 'runner-run-btn';
        btn.className = 'btn accent';
        btn.textContent = runnerAvailable ? '▶ Run via Runner' : '▶ Run via Runner (offline)';
        btn.style.marginLeft = '8px';
        btn.addEventListener('click', runCurrentRowsViaRunner);
        genBtn.insertAdjacentElement('afterend', btn);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await checkHealth();
    injectButton();
  });

  // Public API, mirroring window.ERplorer's pattern
  window.ERplorerRunner = {
    checkHealth,
    runCurrentRowsViaRunner,
    promoteSession,
    baseUrl: BASE_URL
  };
})();
