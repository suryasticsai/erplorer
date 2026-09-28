/**
 * ERplorer Bench AI — the intelligent layer over the Bench module.
 *
 * Three capabilities:
 *   1. Generate dummy data from a plain-English prompt
 *   2. Suggest load test scenarios based on the Insights digest
 *   3. Interpret load test results in plain English
 *
 * Uses the same AI endpoints (primary + fallback) as the rest of ERplorer.
 * Falls back gracefully — every button still works if AI is unreachable.
 *
 * Exposes:
 *   window.ERplorerBenchAI.setLastResult(result)   — called by erplorer-bench.js after a run
 *   window.ERplorerBenchAI.applyScenario(i)        — load a suggested scenario into the load form
 *   window.ERplorerBenchAI.exportInterpretation()  — download last interpretation as Markdown
 *   window.ERplorerBenchExports(format)            — global alias for the AI data preview's export buttons
 */
(function () {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const AI_PRIMARY = (window.ERPLORER_CONFIG && window.ERPLORER_CONFIG.endpoints && window.ERPLORER_CONFIG.endpoints.aiPrimary)
    || 'https://ragina-crawler-ragina.vercel.app/api/ask';
  const AI_FALLBACK = (window.ERPLORER_CONFIG && window.ERPLORER_CONFIG.endpoints && window.ERPLORER_CONFIG.endpoints.aiFallback)
    || 'https://text.pollinations.ai/openai';
  const AI_TIMEOUT_MS = 90000;

  // ============================================================
  // STATE
  // ============================================================
  const A = {
    scenarios: [],           // last AI-suggested load scenarios
    lastResult: null,        // last load test result (set by erplorer-bench.js)
    lastInterpretation: null // last AI interpretation JSON
  };

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

  async function fetchJSON(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // AI CALL + JSON PARSER
  // ============================================================
  async function askAI(prompt) {
    // Primary endpoint
    try {
      const res = await fetchJSON(AI_PRIMARY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: prompt, context: 'You output only valid JSON.' })
      }, AI_TIMEOUT_MS);
      if (res.ok) {
        const d = await res.json();
        const raw = d.answer || d.content || d.response
          || (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
        if (raw) return raw;
      }
    } catch (err) {
      console.warn('[bench-ai] primary failed:', err.message);
    }

    // Fallback endpoint
    try {
      const res = await fetchJSON(AI_FALLBACK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai',
          messages: [
            { role: 'system', content: 'You output only valid JSON. No markdown fences, no explanation.' },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' }
        })
      }, AI_TIMEOUT_MS);
      if (res.ok) {
        const d = await res.json();
        const raw = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (raw) return raw;
      }
    } catch (err) {
      console.warn('[bench-ai] fallback failed:', err.message);
    }

    throw new Error('both AI endpoints failed');
  }

  function parseJSON(raw) {
    let content = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    try {
      return JSON.parse(content);
    } catch (e) {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ }
      }
      throw new Error('AI returned unparseable JSON');
    }
  }

  // ============================================================
  // 1. AI DATA GENERATOR
  // ============================================================
  async function generateDataFromPrompt() {
    const promptEl = document.getElementById('bench-ai-data-prompt');
    const countEl = document.getElementById('bench-ai-data-count');
    const statusEl = document.getElementById('bench-ai-data-status');
    const previewEl = document.getElementById('bench-ai-data-preview');
    if (!promptEl || !statusEl || !previewEl) return;

    const prompt = promptEl.value.trim();
    const count = parseInt(countEl && countEl.value, 10) || 25;

    if (!prompt) { toast('Describe what data you want first'); return; }
    if (count > 200) { toast('AI generation capped at 200 rows'); return; }

    statusEl.style.display = 'block';
    statusEl.className = 'status-line';
    statusEl.innerHTML = '<span class="spinner"></span>Asking AI to design a schema and generate rows…';
    previewEl.innerHTML = '';

    const aiPrompt = 'Generate a JSON array of ' + count + ' realistic dummy data rows.\n\n'
      + 'User\'s description: "' + prompt + '"\n\n'
      + 'Rules:\n'
      + '- Output ONLY a JSON object with this shape: {"columns": ["col1", "col2", ...], "rows": [ {...}, {...} ]}\n'
      + '- Every row must have exactly the same keys as "columns"\n'
      + '- Values must be realistic — real names, real cities, real-looking emails, sensible numbers\n'
      + '- If the user mentions a domain (healthcare, fintech, ecommerce), use domain-appropriate fields\n'
      + '- Include id-like fields when natural, plus created_at timestamps\n'
      + '- Keep total output under 40KB';

    try {
      const raw = await askAI(aiPrompt);
      const parsed = parseJSON(raw);

      if (!parsed.columns || !Array.isArray(parsed.rows)) {
        throw new Error('AI response missing columns or rows');
      }

      const rows = parsed.rows.slice(0, count);

      // Hand rows to the Bench module so its export buttons work
      if (window.ERplorerBench && window.ERplorerBench._setRows) {
        window.ERplorerBench._setRows('ai-' + prompt.slice(0, 30), rows);
      }

      statusEl.className = 'status-line ok';
      statusEl.innerHTML = '✅ AI generated ' + rows.length + ' rows across ' + parsed.columns.length + ' columns. Exports are ready.';

      const cols = parsed.columns;
      previewEl.innerHTML = ''
        + '<div class="ai-badge">🤖 AI-generated</div>'
        + '<div style="font-size:12px; color:var(--muted); margin:8px 0;">'
        +   rows.length + ' rows · ' + cols.length + ' columns · schema inferred by AI'
        + '</div>'
        + '<div style="overflow-x:auto; border-radius:var(--radius);">'
        +   '<table class="data-table">'
        +     '<thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead>'
        +     '<tbody>'
        +       rows.slice(0, 15).map(function (r) {
                  return '<tr>' + cols.map(function (c) {
                    return '<td>' + esc(String(r[c] == null ? '' : r[c]).slice(0, 40)) + '</td>';
                  }).join('') + '</tr>';
                }).join('')
        +     '</tbody>'
        +   '</table>'
        + '</div>'
        + '<div class="row" style="margin-top:14px;">'
        +   '<button class="btn secondary" onclick="ERplorerBenchExports(\'csv\')">⬇ CSV</button>'
        +   '<button class="btn secondary" onclick="ERplorerBenchExports(\'json\')">⬇ JSON</button>'
        +   '<button class="btn secondary" onclick="ERplorerBenchExports(\'sql\')">⬇ SQL</button>'
        +   '<button class="btn secondary" onclick="ERplorerBenchExports(\'xlsx\')">⬇ XLSX</button>'
        + '</div>';
    } catch (err) {
      statusEl.className = 'status-line err';
      statusEl.textContent = 'AI generation failed: ' + err.message;
    }
  }

  // ============================================================
  // 2. AI LOAD SCENARIO SUGGESTER
  // ============================================================
  async function suggestLoadScenarios() {
    const statusEl = document.getElementById('bench-ai-suggest-status');
    const listEl = document.getElementById('bench-ai-suggest-list');
    if (!statusEl || !listEl) return;

    statusEl.style.display = 'block';
    statusEl.className = 'status-line';
    statusEl.innerHTML = '<span class="spinner"></span>Reading the Insights digest and proposing scenarios…';
    listEl.innerHTML = '';

    const digest = (window.ERplorerInsights && window.ERplorerInsights.getDigest)
      ? window.ERplorerInsights.getDigest()
      : null;

    const services = (digest && digest.distinctServices) ? digest.distinctServices.slice(0, 15) : [];
    const envVars = (digest && digest.distinctEnvVars) ? digest.distinctEnvVars.slice(0, 15) : [];
    const classes = (digest && digest.heuristicClasses) ? digest.heuristicClasses : {};
    const fileCount = (digest && digest.fileCount) ? digest.fileCount : 0;

    if (!services.length && !envVars.length) {
      statusEl.className = 'status-line warn';
      statusEl.textContent = 'No insights data yet. Scan a repo in the Ingest tab first.';
      return;
    }

    const aiPrompt = 'You are a performance engineer. Based on this codebase digest, suggest 3-5 load test scenarios that would reveal real bottlenecks.\n\n'
      + 'Digest:\n'
      + '- Files analyzed: ' + fileCount + '\n'
      + '- Code composition: ' + JSON.stringify(classes) + '\n'
      + '- Service URLs found: ' + JSON.stringify(services) + '\n'
      + '- Env vars referenced: ' + JSON.stringify(envVars) + '\n\n'
      + 'Output ONLY this JSON shape:\n'
      + '{\n'
      + '  "scenarios": [\n'
      + '    {\n'
      + '      "name": "short scenario name",\n'
      + '      "url": "full URL or path to hit",\n'
      + '      "method": "GET|POST|PUT|DELETE",\n'
      + '      "concurrency": 10,\n'
      + '      "durationSec": 15,\n'
      + '      "headers": {},\n'
      + '      "body": "",\n'
      + '      "why": "one sentence on what this test reveals",\n'
      + '      "expectedP95": 300\n'
      + '    }\n'
      + '  ]\n'
      + '}\n\n'
      + 'Rules:\n'
      + '- url must be a concrete endpoint or path inferable from the services list\n'
      + '- If you only know a base host, use "/" or "/health"\n'
      + '- concurrency between 1 and 100\n'
      + '- durationSec between 5 and 60\n'
      + '- expectedP95 in milliseconds — your best guess for healthy\n'
      + '- why must be specific\n'
      + '- Max 5 scenarios';

    try {
      const raw = await askAI(aiPrompt);
      const parsed = parseJSON(raw);
      const scenarios = parsed.scenarios || [];
      if (!scenarios.length) throw new Error('AI returned no scenarios');

      A.scenarios = scenarios;

      statusEl.className = 'status-line ok';
      statusEl.innerHTML = '✅ AI proposed ' + scenarios.length + ' scenario' + (scenarios.length === 1 ? '' : 's') + '. Click Run on any one to load it.';

      listEl.innerHTML = scenarios.map(function (s, i) {
        return ''
          + '<div class="scenario-card">'
          +   '<div class="scenario-head">'
          +     '<div class="scenario-name">' + esc(s.name || 'Untitled') + '</div>'
          +     '<div class="scenario-badge">' + esc(s.method || 'GET') + '</div>'
          +   '</div>'
          +   '<div class="scenario-url">' + esc(s.url || '') + '</div>'
          +   '<div class="scenario-meta">'
          +     '<span>' + (s.concurrency || 5) + ' concurrent</span>'
          +     '<span>' + (s.durationSec || 10) + 's</span>'
          +     '<span>p95 target ' + (s.expectedP95 || '—') + 'ms</span>'
          +   '</div>'
          +   '<div class="scenario-why">' + esc(s.why || '') + '</div>'
          +   '<button class="btn secondary" onclick="ERplorerBenchAI.applyScenario(' + i + ')" style="margin-top:10px;">Load into Load Test tab</button>'
          + '</div>';
      }).join('');
    } catch (err) {
      statusEl.className = 'status-line err';
      statusEl.textContent = 'AI suggestion failed: ' + err.message;
    }
  }

  function applyScenario(i) {
    const s = A.scenarios[i];
    if (!s) return;

    const urlInput = document.getElementById('bench-load-url');
    const methodInput = document.getElementById('bench-load-method');
    const concurrencyInput = document.getElementById('bench-load-concurrency');
    const durationInput = document.getElementById('bench-load-duration');
    const headersInput = document.getElementById('bench-load-headers');
    const bodyInput = document.getElementById('bench-load-body');

    if (urlInput) urlInput.value = s.url || '';
    if (methodInput) methodInput.value = s.method || 'GET';
    if (concurrencyInput) concurrencyInput.value = s.concurrency || 5;
    if (durationInput) durationInput.value = s.durationSec || 10;
    if (headersInput) headersInput.value = JSON.stringify(s.headers || {}, null, 2);
    if (bodyInput) bodyInput.value = s.body || '';

    // Switch to the Load Test sub-tab
    const loadTab = document.querySelector('.subtab[data-bench="load"]');
    if (loadTab) loadTab.click();

    toast('Scenario loaded — click Run when ready');
  }

  // ============================================================
  // 3. AI RESULT INTERPRETER
  // ============================================================
  async function interpretResults() {
    const statusEl = document.getElementById('bench-ai-interpret-status');
    const outEl = document.getElementById('bench-ai-interpret');
    if (!statusEl || !outEl) return;

    const r = A.lastResult;
    if (!r) { toast('Run a load test first'); return; }

    statusEl.style.display = 'block';
    statusEl.className = 'status-line';
    statusEl.innerHTML = '<span class="spinner"></span>AI is reading the results…';
    outEl.innerHTML = '';

    const aiPrompt = 'You are a performance engineer. Interpret this load test result.\n\n'
      + 'Result:\n'
      + JSON.stringify(r, null, 2)
      + '\n\n'
      + 'Output ONLY this JSON shape:\n'
      + '{\n'
      + '  "verdict": "healthy|degraded|failing|inconclusive",\n'
      + '  "headline": "one-sentence summary anyone can understand",\n'
      + '  "findings": [\n'
      + '    { "severity": "high|medium|low", "title": "short", "detail": "specific reasoning grounded in the numbers" }\n'
      + '  ],\n'
      + '  "bottleneck": "the single most likely bottleneck, or \'none evident\'",\n'
      + '  "nextAction": "one concrete next step"\n'
      + '}\n\n'
      + 'Rules:\n'
      + '- Base conclusions strictly on the numbers\n'
      + '- If latency stays flat as concurrency rises, say the endpoint scales\n'
      + '- If latency grows super-linearly, call out the knee in the curve\n'
      + '- If p99 >> p50, mention tail latency and possible GC, cold starts, or lock contention\n'
      + '- If there are errors, prioritize them over latency findings\n'
      + '- Max 4 findings, ordered by severity';

    try {
      const raw = await askAI(aiPrompt);
      const parsed = parseJSON(raw);
      A.lastInterpretation = parsed;

      const verdictClass = {
        healthy: 'ok',
        degraded: 'warn',
        failing: 'err',
        inconclusive: 'warn'
      }[parsed.verdict] || 'warn';

      statusEl.style.display = 'none';

      outEl.innerHTML = ''
        + '<div class="ai-badge">🤖 AI interpretation</div>'
        + '<div class="env-verdict ' + verdictClass + '" style="margin-top:12px;">'
        +   '<span class="env-dot"></span>'
        +   '<strong>' + esc(String(parsed.verdict || 'unknown').toUpperCase()) + ': ' + esc(parsed.headline || '') + '</strong>'
        + '</div>'
        + '<div style="margin-top:14px;">'
        +   (parsed.findings || []).map(function (f) {
              return ''
                + '<div class="finding-row">'
                +   '<div class="finding-head">'
                +     '<span class="smell-severity sev-' + (f.severity || 'low') + '">' + esc(f.severity || 'low') + '</span>'
                +     '<strong>' + esc(f.title || '') + '</strong>'
                +   '</div>'
                +   '<div class="finding-detail">' + esc(f.detail || '') + '</div>'
                + '</div>';
            }).join('')
        + '</div>'
        + (parsed.bottleneck && parsed.bottleneck !== 'none evident' ? (
            '<div class="insights-card" style="margin-top:14px; background:var(--accent-soft);">'
            + '<div class="card-title" style="font-size:14px;">Most likely bottleneck</div>'
            + '<div style="font-size:13px; color:var(--ink-2); margin-top:6px;">' + esc(parsed.bottleneck) + '</div>'
            + '</div>'
          ) : '')
        + (parsed.nextAction ? (
            '<div class="insights-card" style="margin-top:12px;">'
            + '<div class="card-title" style="font-size:14px;">Next action</div>'
            + '<div style="font-size:13px; color:var(--ink-2); margin-top:6px;">' + esc(parsed.nextAction) + '</div>'
            + '</div>'
          ) : '')
        + '<button class="btn secondary" onclick="ERplorerBenchAI.exportInterpretation()" style="margin-top:14px;">⬇ Export interpretation as Markdown</button>';
    } catch (err) {
      statusEl.className = 'status-line err';
      statusEl.textContent = 'AI interpretation failed: ' + err.message;
    }
  }

  function exportInterpretation() {
    const parsed = A.lastInterpretation;
    const r = A.lastResult;
    if (!parsed || !r) { toast('Nothing to export'); return; }

    const lines = [];
    lines.push('# Load Test Interpretation');
    lines.push('');
    lines.push('**Target:** ' + r.method + ' ' + r.url);
    lines.push('**Concurrency:** ' + r.concurrency + ' · **Duration:** ' + (r.durationMs / 1000).toFixed(1) + 's');
    lines.push('**Mode:** ' + (r.runner ? 'runner' : 'browser'));
    lines.push('**Generated:** ' + new Date().toLocaleString());
    lines.push('');
    lines.push('## Verdict: ' + String(parsed.verdict || 'unknown').toUpperCase());
    lines.push('');
    lines.push(parsed.headline || '');
    lines.push('');
    lines.push('## Findings');
    lines.push('');
    (parsed.findings || []).forEach(function (f) {
      lines.push('### [' + (f.severity || 'low') + '] ' + (f.title || ''));
      lines.push('');
      lines.push(f.detail || '');
      lines.push('');
    });
    lines.push('## Bottleneck');
    lines.push('');
    lines.push(parsed.bottleneck || 'none evident');
    lines.push('');
    lines.push('## Next Action');
    lines.push('');
    lines.push(parsed.nextAction || '—');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Raw numbers');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push('| Total requests | ' + r.total + ' |');
    lines.push('| Success / Failed | ' + r.success + ' / ' + r.failed + ' |');
    lines.push('| Throughput | ' + r.rps.toFixed(1) + ' req/s |');
    lines.push('| p50 latency | ' + r.latencies.p50.toFixed(1) + ' ms |');
    lines.push('| p90 latency | ' + r.latencies.p90.toFixed(1) + ' ms |');
    lines.push('| p95 latency | ' + r.latencies.p95.toFixed(1) + ' ms |');
    lines.push('| p99 latency | ' + r.latencies.p99.toFixed(1) + ' ms |');
    lines.push('| Max latency | ' + r.latencies.max.toFixed(1) + ' ms |');
    lines.push('');
    lines.push('_Generated by ERplorer Bench AI_');

    const md = lines.join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadFile('load-interpretation-' + ts + '.md', md, 'text/markdown');
    toast('📄 Markdown exported');
  }

  // ============================================================
  // BRIDGES + BOOT
  // ============================================================
  // Called by erplorer-bench.js after every load test completes
  function setLastResult(result) {
    A.lastResult = result;
  }

  function boot() {
    const dataBtn = document.getElementById('bench-ai-data-generate');
    if (dataBtn) dataBtn.addEventListener('click', generateDataFromPrompt);

    const suggestBtn = document.getElementById('bench-ai-suggest');
    if (suggestBtn) suggestBtn.addEventListener('click', suggestLoadScenarios);

    const interpBtn = document.getElementById('bench-ai-interpret-btn');
    if (interpBtn) interpBtn.addEventListener('click', interpretResults);
  }

  window.ERplorerBenchAI = {
    setLastResult: setLastResult,
    applyScenario: applyScenario,
    exportInterpretation: exportInterpretation,
    state: function () {
      return {
        scenarios: A.scenarios.length,
        hasResult: !!A.lastResult,
        hasInterpretation: !!A.lastInterpretation
      };
    }
  };

  // Global alias for the AI data preview's export buttons.
  // Delegates to the Bench module's exportCurrent, which uses the
  // rows pushed by _setRows() above.
  window.ERplorerBenchExports = function (format) {
    if (window.ERplorerBench && window.ERplorerBench.exportCurrent) {
      window.ERplorerBench.exportCurrent(format);
    } else {
      toast('Export bridge not available');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();