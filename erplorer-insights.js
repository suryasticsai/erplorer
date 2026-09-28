/**
 * ERplorer Insights — AI-powered static analysis.
 *
 * Two-stage pipeline:
 *   1. Fast structural extraction (regex, in-browser, <100ms)
 *   2. AI interpretation (compact digest → structured JSON → dashboard)
 *
 * Falls back to the heuristic-only view if the AI is unreachable,
 * so the panel is never empty. Results are cached in localStorage
 * for 6 hours keyed by a hash of the digest.
 *
 * Reads from:
 *   - window._erplorerFileContents  (Map<path, content>, populated by erplorer.js during ingest)
 *   - window.ERplorer.state().documents  (error entries, always available)
 *
 * Renders into:
 *   - #insights-root
 *
 * Exposes:
 *   - window.ERplorerInsights.refresh()      — run pipeline + render
 *   - window.ERplorerInsights.reanalyze()    — bypass cache
 *   - window.ERplorerInsights.getDigest()    — returns current digest (used by bench-ai)
 *   - window.ERplorerInsights.state()        — diagnostic state
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
  const CACHE_PREFIX = 'erplorer_insights_';
  const CACHE_TTL_MS = 6 * 3600 * 1000;

  // ============================================================
  // STATE
  // ============================================================
  const S = {
    files: new Map(),        // path → { content, class, imports, services, envs, smells }
    edges: [],               // { from, to, kind: 'import'|'service' }
    hubs: [],                // [{ path, degree, imports, dependents }]
    envs: { stages: {}, hosts: {}, vars: {} },
    classes: {},
    smells: [],
    digest: null,
    ai: null,
    aiPending: false,
    aiError: null,
    rendered: false
  };

  // ============================================================
  // UTILITIES
  // ============================================================
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const escXml = s => String(s == null ? '' : s).replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

  const truncate = (s, n) => {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  const ext = p => {
    const m = String(p).match(/(\.[a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  };

  const extFull = p => {
    const parts = String(p).split('.');
    return parts.length > 1 ? '.' + parts.slice(-2).join('.').toLowerCase() : '';
  };

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
  // STRUCTURAL EXTRACTION
  // ============================================================
  function extractImports(content, path) {
    const e = ext(path);
    const out = new Set();

    if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'].includes(e)) {
      for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
      for (const m of content.matchAll(/import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g)) out.add(m[1]);
      for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
    } else if (e === '.py') {
      for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) out.add(m[1]);
      for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) out.add(m[1]);
    } else if (['.java', '.kt', '.groovy', '.scala'].includes(e)) {
      for (const m of content.matchAll(/^\s*import\s+([\w.]+);?/gm)) out.add(m[1]);
    }
    return [...out];
  }

  function extractServices(content) {
    const out = new Set();
    for (const m of content.matchAll(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g)) out.add(m[1]);
    for (const m of content.matchAll(/axios\.\w+\s*\(\s*['"`]([^'"`]+)['"`]/g)) out.add(m[1]);
    for (const m of content.matchAll(/['"`](https?:\/\/[^\s'"`<>{}$]+)['"`]/g)) out.add(m[1]);
    return [...out];
  }

  function extractEnvHints(content) {
    const vars = new Set();
    const hosts = new Set();
    const stages = new Set();

    for (const m of content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) vars.add(m[1]);
    for (const m of content.matchAll(/os\.(?:environ\.get|getenv)\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) vars.add(m[1]);
    for (const m of content.matchAll(/System\.getenv\s*\(\s*"([A-Z_][A-Z0-9_]*)"/g)) vars.add(m[1]);
    for (const m of content.matchAll(/https?:\/\/([^\/\s'"`<>:]+)/g)) hosts.add(m[1]);
    for (const m of content.matchAll(/\b(production|staging|development|dev|prod|test|qa|uat|sandbox|localhost)\b/gi)) {
      stages.add(m[1].toLowerCase());
    }
    return { vars: [...vars], hosts: [...hosts], stages: [...stages] };
  }

  function detectSmells(content) {
    const out = [];
    const tally = (type, re) => {
      const m = content.match(re);
      if (m) out.push({ type, count: m.length });
    };
    tally('TODO', /\bTODO\b/g);
    tally('FIXME', /\bFIXME\b/g);
    tally('HACK', /\bHACK\b/g);
    tally('console.log', /console\.(log|debug|info)\s*\(/g);
    tally('empty catch', /catch\s*\([^)]*\)\s*\{\s*\}/g);
    tally('eval()', /\beval\s*\(/g);
    tally('innerHTML=', /\.innerHTML\s*=/g);
    const secrets = content.match(/(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"]([^'"]{8,})['"]/gi);
    if (secrets) out.push({ type: 'possible hardcoded secret', count: secrets.length });
    return out;
  }

  function classifyFile(path, content) {
    const e = ext(path);
    const ef = extFull(path);
    const lower = path.toLowerCase();

    if (/\/(tests?|__tests__|specs?)\//.test(lower)) return 'Test';
    if (/\/(docs?|documentation)\//.test(lower) || /\.(md|rst)$/i.test(path)) return 'Docs';
    if (/\.(sql|ipynb)$/i.test(path)) return 'Data';

    const score = { UI: 0, Backend: 0, Data: 0, Test: 0, Config: 0, Docs: 0 };

    if (['.jsx', '.tsx', '.vue', '.svelte', '.html', '.css', '.scss'].includes(e)) score.UI += 3;
    if (['.java', '.kt', '.groovy', '.scala'].includes(e)) score.Backend += 3;
    if (['.yaml', '.yml', '.toml', '.ini', '.properties', '.env'].includes(e)) score.Config += 3;
    if (e === '.sql' || ef === '.ipynb') score.Data += 3;

    if (/\b(React|useState|useEffect|render\s*\(|<[A-Z][A-Za-z]+[\s>])/.test(content)) score.UI += 4;
    if (/\b(express|fastify|koa|SpringBoot|RestController|app\.(get|post|put|delete)\s*\()/.test(content)) score.Backend += 4;
    if (/\b(SELECT|INSERT|UPDATE|CREATE\s+TABLE|spark\.sql|dataframe)/i.test(content)) score.Data += 3;
    if (/\b(describe|it|test|expect)\s*\(|jest|mocha|pytest|playwright/.test(content)) score.Test += 3;

    const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : 'Other';
  }

  // ============================================================
  // IMPORT RESOLUTION
  // ============================================================
  function resolveImport(fromPath, imp, allPaths) {
    if (!imp.startsWith('.') && !imp.startsWith('/')) return null;
    const baseDir = fromPath.split('/').slice(0, -1).join('/');
    const candidates = [
      imp, imp + '.js', imp + '.ts', imp + '.jsx', imp + '.tsx',
      imp + '.py', imp + '.java', imp + '/index.js', imp + '/index.ts', imp + '/__init__.py'
    ];
    const set = new Set(allPaths);
    for (const c of candidates) {
      const parts = (baseDir + '/' + c).split('/');
      const out = [];
      for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') out.pop(); else out.push(p);
      }
      const norm = out.join('/');
      if (set.has(norm)) return norm;
    }
    return null;
  }

  // ============================================================
  // STRUCTURAL PIPELINE
  // ============================================================
  function runStructuralAnalysis() {
    S.files.clear();
    S.edges = [];
    S.smells = [];
    S.classes = {};
    S.envs = { stages: {}, hosts: {}, vars: {} };

    const contents = window._erplorerFileContents || new Map();
    if (contents.size === 0) return;

    const allPaths = [...contents.keys()];

    for (const [path, content] of contents) {
      const cls = classifyFile(path, content);
      const imports = extractImports(content, path);
      const services = extractServices(content);
      const envs = extractEnvHints(content);
      const smells = detectSmells(content);

      S.files.set(path, { content, class: cls, imports, services, envs, smells });

      for (const v of envs.vars) S.envs.vars[v] = (S.envs.vars[v] || 0) + 1;
      for (const h of envs.hosts) S.envs.hosts[h] = (S.envs.hosts[h] || 0) + 1;
      for (const st of envs.stages) S.envs.stages[st] = (S.envs.stages[st] || 0) + 1;
      for (const sm of smells) S.smells.push(Object.assign({ path }, sm));
    }

    for (const [path, f] of S.files) {
      for (const imp of f.imports) {
        const target = resolveImport(path, imp, allPaths);
        if (target) S.edges.push({ from: path, to: target, kind: 'import' });
      }
      for (const svc of f.services) {
        S.edges.push({ from: path, to: svc, kind: 'service' });
      }
    }

    for (const f of S.files.values()) {
      S.classes[f.class] = (S.classes[f.class] || 0) + 1;
    }

    // Hubs
    const degree = new Map();
    const incoming = new Map();
    for (const p of S.files.keys()) degree.set(p, 0);
    for (const e of S.edges) {
      if (e.kind !== 'import') continue;
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
      incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    }
    S.hubs = [...degree.entries()]
      .map(([path, deg]) => ({
        path,
        degree: deg,
        imports: (S.files.get(path).imports || []).length,
        dependents: incoming.get(path) || 0
      }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8);
  }

  // ============================================================
  // DIGEST BUILDER
  // ============================================================
  function buildDigest() {
    const files = [...S.files.entries()];
    const langs = {};
    for (const [path] of files) {
      const e = ext(path);
      langs[e] = (langs[e] || 0) + 1;
    }

    const topPaths = new Set();
    for (const h of S.hubs.slice(0, 6)) topPaths.add(h.path);
    for (const [path, f] of files) {
      if (topPaths.size >= 15) break;
      if (f.services.length) topPaths.add(path);
    }
    for (const [path, f] of files) {
      if (topPaths.size >= 18) break;
      if (f.envs.vars.length) topPaths.add(path);
    }

    const topFiles = [...topPaths].slice(0, 18).map(path => {
      const f = S.files.get(path);
      const snippet = (f.content || '').split('\n').slice(0, 25).join('\n').slice(0, 700);
      return {
        path,
        class: f.class,
        sizeKB: Math.round((f.content || '').length / 1024),
        imports: f.imports.slice(0, 6),
        services: f.services.slice(0, 4),
        envVars: f.envs.vars.slice(0, 6),
        snippet
      };
    });

    const allImports = new Set();
    const allServices = new Set();
    const allEnvVars = new Set();
    for (const [, f] of files) {
      for (const i of f.imports) allImports.add(i);
      for (const s of f.services) allServices.add(s);
      for (const v of f.envs.vars) allEnvVars.add(v);
    }

    return {
      fileCount: files.length,
      languages: langs,
      allPaths: files.map(([p]) => p).slice(0, 120),
      topFiles,
      distinctImports: [...allImports].slice(0, 40),
      distinctServices: [...allServices].slice(0, 20),
      distinctEnvVars: [...allEnvVars].slice(0, 25),
      heuristicClasses: S.classes,
      heuristicStages: S.envs.stages,
      heuristicSmellTotal: S.smells.reduce((a, s) => a + s.count, 0)
    };
  }

  function hashDigest(digest) {
    const s = JSON.stringify(digest);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  // ============================================================
  // AI INTERPRETATION
  // ============================================================
  const AI_PROMPT = `You are a senior engineer doing a code review of a repository. Based on the digest below, produce a JSON object with EXACTLY this schema. No markdown, no explanation, only the JSON.

{
  "verdict": "1-2 sentence plain-English summary of what this repo IS and does.",
  "architecture": {
    "pattern": "monolith|microservice|serverless|spa|library|cli|static-site|hybrid|unknown",
    "confidence": 0,
    "reasoning": "why you chose this pattern, in 1 sentence"
  },
  "classification": {
    "backend": 0, "frontend": 0, "data": 0, "config": 0, "test": 0, "docs": 0
  },
  "environment": {
    "verdict": "development|staging|production|mixed|unknown",
    "confidence": 0,
    "evidence": ["specific signal 1", "signal 2"]
  },
  "criticalFiles": [
    { "path": "exact/path/from/digest.js", "why": "one-line reason this file matters", "risk": "high|medium|low" }
  ],
  "services": [
    { "host": "api.stripe.com", "purpose": "what it's likely used for" }
  ],
  "smells": [
    { "type": "TODO", "count": 0, "severity": "high|medium|low", "context": "meaningful explanation" }
  ],
  "flow": {
    "nodes": [
      { "id": "short-id", "label": "Display Name", "kind": "entry|service|data|util|config" }
    ],
    "edges": [
      { "from": "short-id", "to": "short-id", "label": "optional" }
    ]
  },
  "nextSteps": ["Concrete action 1", "Action 2", "Action 3"]
}

Rules:
- classification values are 0-100 and SHOULD sum to roughly 100.
- criticalFiles: max 5. Only files whose failure would break the system.
- flow.nodes: max 12. IDs must be short slugs.
- flow.edges: max 20.
- smells: max 6, ordered by severity descending.
- nextSteps: max 4, each concrete and actionable.

Digest:
`;

  async function askAI(digest) {
    const prompt = AI_PROMPT + JSON.stringify(digest, null, 2);

    let raw = null;

    try {
      const res = await fetchJSON(AI_PRIMARY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: prompt, context: 'You output only valid JSON.' })
      }, AI_TIMEOUT_MS);
      if (res.ok) {
        const data = await res.json();
        raw = data.answer || data.content || data.response
          || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
          || null;
      }
    } catch (err) {
      console.warn('[insights] primary AI failed:', err.message);
    }

    if (!raw) {
      try {
        const res = await fetchJSON(AI_FALLBACK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai',
            messages: [
              { role: 'system', content: 'You output only valid JSON. No markdown fences.' },
              { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
          })
        }, AI_TIMEOUT_MS);
        if (res.ok) {
          const data = await res.json();
          raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;
        }
      } catch (err) {
        console.warn('[insights] fallback AI failed:', err.message);
      }
    }

    if (!raw) throw new Error('both AI endpoints failed');

    let content = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    try {
      return JSON.parse(content);
    } catch (err) {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (e) { /* fall through */ }
      }
      throw new Error('AI returned unparseable JSON');
    }
  }

  // ============================================================
  // CACHE
  // ============================================================
  function getCached(hash) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + hash);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > CACHE_TTL_MS) {
        localStorage.removeItem(CACHE_PREFIX + hash);
        return null;
      }
      return parsed.data;
    } catch (e) { return null; }
  }

  function setCached(hash, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + hash, JSON.stringify({ ts: Date.now(), data }));
    } catch (e) { /* quota exceeded — ignore */ }
  }

  // ============================================================
  // ORCHESTRATOR
  // ============================================================
  async function refresh() {
    const root = document.getElementById('insights-root');
    if (!root) return;

    runStructuralAnalysis();

    if (S.files.size === 0) {
      renderEmpty(root);
      return;
    }

    S.ai = null;
    S.aiError = null;
    S.aiPending = true;
    renderDashboard(root);

    try {
      const digest = buildDigest();
      S.digest = digest;
      const hash = hashDigest(digest);
      const cached = getCached(hash);

      if (cached) {
        S.ai = cached;
        S.aiPending = false;
        renderDashboard(root);
        return;
      }

      const result = await askAI(digest);
      S.ai = result;
      S.aiPending = false;
      setCached(hash, result);
      renderDashboard(root);
    } catch (err) {
      S.aiError = err.message;
      S.aiPending = false;
      renderDashboard(root);
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderEmpty(root) {
    root.innerHTML = `
      <div class="hero">
        <div class="hero-eyebrow">Insights</div>
        <h1 class="hero-title">Nothing to analyze yet.</h1>
        <p class="hero-desc">Scan a repo or drop files in the <strong>Ingest</strong> tab. The AI-powered dashboard builds automatically once files are indexed.</p>
      </div>
    `;
  }

  function renderDashboard(root) {
    const ai = S.ai;
    const totalFiles = S.files.size;
    const totalEdges = S.edges.filter(e => e.kind === 'import').length;
    const totalServices = new Set(S.edges.filter(e => e.kind === 'service').map(e => e.to)).size;
    const smellTotal = S.smells.reduce((a, s) => a + s.count, 0);

    root.innerHTML = `
      <div class="hero" style="margin-bottom:20px;">
        <div class="hero-eyebrow">Insights ${S.aiPending ? '· analyzing…' : ai ? '· AI-enriched' : '· heuristic only'}</div>
        <h1 class="hero-title">${ai ? esc(ai.verdict || 'Repository analysis') : `${totalFiles} files analyzed.`}</h1>
        <p class="hero-desc">${ai
          ? `Architecture: <strong>${esc((ai.architecture && ai.architecture.pattern) || 'unknown')}</strong> (${(ai.architecture && ai.architecture.confidence) || 0}% confidence)${ai.architecture && ai.architecture.reasoning ? ' — ' + esc(ai.architecture.reasoning) : ''}`
          : 'Fast structural analysis. AI interpretation is loading…'}</p>
      </div>

      ${S.aiPending ? '<div class="status-line"><span class="spinner"></span> AI is reading the digest and producing an interpretation. Usually 5–15 seconds.</div>' : ''}
      ${S.aiError ? `<div class="status-line warn">⚠️ AI interpretation unavailable (${esc(S.aiError)}). Showing heuristic analysis only.</div>` : ''}

      <div class="insights-stats">
        <div class="insight-stat"><div class="num">${totalFiles}</div><div class="lbl">files</div></div>
        <div class="insight-stat"><div class="num">${totalEdges}</div><div class="lbl">import edges</div></div>
        <div class="insight-stat"><div class="num">${totalServices}</div><div class="lbl">external services</div></div>
        <div class="insight-stat"><div class="num">${smellTotal}</div><div class="lbl">smells</div></div>
      </div>

      <div class="insights-grid">
        ${ai ? renderAIClassification(ai) : renderHeuristicComposition()}
        ${ai ? renderAIEnvironment(ai) : renderHeuristicEnvironment()}
      </div>

      <div class="insights-grid">
        ${ai && ai.criticalFiles && ai.criticalFiles.length ? renderCriticalFiles(ai) : renderHubsCard()}
        ${ai && ai.smells && ai.smells.length ? renderAISmells(ai) : renderHeuristicSmells()}
      </div>

      <div class="insights-grid">
        <div class="insights-card" style="grid-column: 1 / -1;">
          <div class="card-title">${ai ? 'Flow diagram' : 'Top hubs'}</div>
          <div class="card-desc">${ai ? 'AI-drawn data flow across the system.' : 'Most-connected files in the corpus.'}</div>
          ${ai && ai.flow && ai.flow.nodes && ai.flow.nodes.length ? renderAIFlow(ai.flow) : renderHeuristicFlow()}
        </div>
      </div>

      ${ai && ai.services && ai.services.length ? `
        <div class="insights-grid">
          <div class="insights-card" style="grid-column: 1 / -1;">
            <div class="card-title">External services</div>
            <div class="card-desc">What this codebase talks to, and likely why.</div>
            <div style="margin-top:12px;">
              ${ai.services.map(s => `
                <div class="service-row">
                  <code class="service-host">${esc(s.host)}</code>
                  <span class="service-purpose">${esc(s.purpose || '')}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      ` : ''}

      ${ai && ai.nextSteps && ai.nextSteps.length ? `
        <div class="insights-card" style="margin-bottom:12px;">
          <div class="card-title">Suggested next steps</div>
          <div class="card-desc">Where to start if you're new to this repo.</div>
          <ol class="next-steps">
            ${ai.nextSteps.map(s => `<li>${esc(s)}</li>`).join('')}
          </ol>
        </div>
      ` : ''}

      <div class="insights-grid">
        <div class="insights-card" style="grid-column: 1 / -1;">
          <div class="card-title">Project tree</div>
          <div class="card-desc">Directory hierarchy. Color-coded by detected class.</div>
          <div id="insights-tree-container">${renderTree()}</div>
        </div>
      </div>
    `;

    if (!S.rendered) {
      S.rendered = true;
      setTimeout(animateTree, 300);
    }
  }

  // ---- AI cards ----
  function renderAIClassification(ai) {
    const c = ai.classification || {};
    const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    const rows = Object.entries(c)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, val]) => {
        const pct = Math.round((val / total) * 100);
        return `
          <div class="comp-row">
            <div class="comp-label"><span class="comp-dot class-${name}"></span>${esc(name)}</div>
            <div class="comp-bar-track"><div class="comp-bar class-${name}" style="width:${pct}%"></div></div>
            <div class="comp-count">${pct}%</div>
          </div>
        `;
      }).join('');
    return `
      <div class="insights-card">
        <div class="card-title">Code classification</div>
        <div class="card-desc">AI-assessed split across the codebase.</div>
        <div style="margin-top:14px;">${rows}</div>
      </div>
    `;
  }

  function renderAIEnvironment(ai) {
    const env = ai.environment || {};
    const cls = env.verdict === 'production' ? 'err'
      : env.verdict === 'staging' ? 'warn'
      : env.verdict === 'development' ? 'ok' : 'warn';
    const evidence = (env.evidence || []).map(e => `<li>${esc(e)}</li>`).join('');
    return `
      <div class="insights-card">
        <div class="card-title">Environment</div>
        <div class="card-desc">AI-assessed deployment target.</div>
        <div style="margin-top:14px;">
          <div class="env-verdict ${cls}">
            <span class="env-dot"></span>
            <strong>Likely ${esc(env.verdict || 'unknown')} (${env.confidence || 0}%)</strong>
          </div>
          ${evidence ? `<ul class="env-evidence">${evidence}</ul>` : ''}
        </div>
      </div>
    `;
  }

  function renderCriticalFiles(ai) {
    return `
      <div class="insights-card">
        <div class="card-title">Critical files</div>
        <div class="card-desc">AI-identified files whose failure would break the system.</div>
        <div style="margin-top:14px;">
          ${ai.criticalFiles.map(f => `
            <div class="critical-row">
              <div class="critical-head">
                <code class="critical-path">${esc(f.path)}</code>
                <span class="critical-risk risk-${f.risk || 'low'}">${esc(f.risk || 'low')}</span>
              </div>
              <div class="critical-why">${esc(f.why || '')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderAISmells(ai) {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    const rows = [...ai.smells].sort((a, b) =>
      (sevOrder[a.severity] != null ? sevOrder[a.severity] : 3)
      - (sevOrder[b.severity] != null ? sevOrder[b.severity] : 3)
    ).map(s => `
      <div class="smell-row ai-smell" style="display:block;">
        <div class="smell-head">
          <span class="smell-type">${esc(s.type)}</span>
          <span class="smell-count">×${s.count}</span>
          <span class="smell-severity sev-${s.severity || 'low'}">${esc(s.severity || 'low')}</span>
        </div>
        <div class="smell-context">${esc(s.context || '')}</div>
      </div>
    `).join('');
    return `
      <div class="insights-card">
        <div class="card-title">Code smells</div>
        <div class="card-desc">AI-assessed severity with context.</div>
        <div style="margin-top:14px;">${rows}</div>
      </div>
    `;
  }

  // ---- Heuristic fallback cards ----
  function renderHeuristicComposition() {
    const total = S.files.size || 1;
    const rows = Object.entries(S.classes).sort((a, b) => b[1] - a[1]).map(([name, count]) => {
      const pct = Math.round((count / total) * 100);
      return `
        <div class="comp-row">
          <div class="comp-label"><span class="comp-dot class-${name.toLowerCase()}"></span>${esc(name)}</div>
          <div class="comp-bar-track"><div class="comp-bar class-${name.toLowerCase()}" style="width:${pct}%"></div></div>
          <div class="comp-count">${count}</div>
        </div>
      `;
    }).join('');
    return `
      <div class="insights-card">
        <div class="card-title">Code composition</div>
        <div class="card-desc">Heuristic classification. AI interpretation loading…</div>
        <div style="margin-top:14px;">${rows}</div>
      </div>
    `;
  }

  function renderHeuristicEnvironment() {
    const stages = Object.entries(S.envs.stages).sort((a, b) => b[1] - a[1]);
    const vars = Object.entries(S.envs.vars).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const hosts = Object.entries(S.envs.hosts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    let verdict = 'unknown', cls = 'warn';
    if (stages.length) {
      const top = stages[0][0];
      if (top === 'production' || top === 'prod') { verdict = 'production'; cls = 'err'; }
      else if (top === 'staging') { verdict = 'staging'; cls = 'warn'; }
      else if (['development', 'dev', 'localhost'].includes(top)) { verdict = 'development'; cls = 'ok'; }
    }
    return `
      <div class="insights-card">
        <div class="card-title">Environment signals</div>
        <div class="card-desc">Detected from env vars and hostnames.</div>
        <div style="margin-top:14px;">
          <div class="env-verdict ${cls}"><span class="env-dot"></span><strong>Likely ${verdict}</strong></div>
          ${vars.length ? `<div class="env-block"><div class="env-block-label">Env vars</div>${vars.map(([k]) => `<code>${esc(k)}</code>`).join(' ')}</div>` : ''}
          ${hosts.length ? `<div class="env-block"><div class="env-block-label">Hosts</div>${hosts.map(([h]) => `<code>${esc(h)}</code>`).join(' ')}</div>` : ''}
        </div>
      </div>
    `;
  }

  function renderHubsCard() {
    if (!S.hubs.length) {
      return '<div class="insights-card"><div class="card-title">Hub files</div><div class="card-desc">No internal imports found.</div></div>';
    }
    return `
      <div class="insights-card">
        <div class="card-title">Hub files</div>
        <div class="card-desc">Most-connected files by import degree.</div>
        <div style="margin-top:14px;">
          ${S.hubs.slice(0, 6).map(h => `
            <div class="hub-row">
              <div class="hub-path">${esc(h.path)}</div>
              <div class="hub-degree">↗ ${h.imports} · ↙ ${h.dependents}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderHeuristicSmells() {
    if (!S.smells.length) {
      return '<div class="insights-card"><div class="card-title">Code smells</div><div class="card-desc">None detected.</div></div>';
    }
    const byType = {};
    for (const s of S.smells) {
      if (!byType[s.type]) byType[s.type] = { count: 0, paths: new Set() };
      byType[s.type].count += s.count;
      if (byType[s.type].paths.size < 3) byType[s.type].paths.add(s.path);
    }
    return `
      <div class="insights-card">
        <div class="card-title">Code smells</div>
        <div class="card-desc">Heuristic counts. AI interpretation loading…</div>
        <div style="margin-top:14px;">
          ${Object.entries(byType).sort((a, b) => b[1].count - a[1].count).map(([type, d]) => `
            <div class="smell-row">
              <div class="smell-type">${esc(type)}</div>
              <div class="smell-count">×${d.count}</div>
              <div class="smell-sample">${[...d.paths].map(esc).join(', ')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // ---- Flow SVGs ----
  function renderAIFlow(flow) {
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    if (!nodes.length) return '<div class="empty">No flow data.</div>';

    const kinds = { entry: [], util: [], data: [], config: [], service: [] };
    for (const n of nodes) (kinds[n.kind] || kinds.util).push(n);

    const columns = [
      { kind: 'entry', nodes: kinds.entry, x: 100 },
      { kind: 'util', nodes: kinds.util, x: 300 },
      { kind: 'data', nodes: [...kinds.data, ...kinds.config], x: 300 },
      { kind: 'service', nodes: kinds.service, x: 620 }
    ].filter(c => c.nodes.length);

    const rowH = 70;
    const maxRows = Math.max.apply(null, columns.map(c => c.nodes.length).concat([1]));
    const height = Math.max(320, maxRows * rowH + 80);
    const width = 760;

    const positions = new Map();
    for (const col of columns) {
      const totalH = col.nodes.length * rowH;
      const startY = (height - totalH) / 2 + rowH / 2;
      col.nodes.forEach((n, i) => {
        positions.set(n.id, { x: col.x, y: startY + i * rowH, node: n });
      });
    }

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="flow-svg" xmlns="http://www.w3.org/2000/svg">';
    svg += '<defs>'
      + '<marker id="arrow-h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94A3B8"/></marker>'
      + '<marker id="arrow-s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#1E40AF"/></marker>'
      + '</defs>';

    for (const e of edges) {
      const from = positions.get(e.from);
      const to = positions.get(e.to);
      if (!from || !to) continue;
      const isSvc = to.node.kind === 'service';
      const midX = (from.x + to.x) / 2;
      const path = `M ${from.x + 70} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 70} ${to.y}`;
      svg += `<path d="${path}" stroke="${isSvc ? '#1E40AF' : '#94A3B8'}" stroke-width="${isSvc ? 1.5 : 1}" fill="none"${isSvc ? ' stroke-dasharray="4 3"' : ''} marker-end="url(#${isSvc ? 'arrow-s' : 'arrow-h'})"/>`;
      if (e.label) {
        svg += `<text x="${midX}" y="${(from.y + to.y) / 2 - 4}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="#94A3B8">${escXml(truncate(e.label, 18))}</text>`;
      }
    }

    for (const entry of positions.values()) {
      const x = entry.x, y = entry.y, node = entry.node;
      const kind = node.kind || 'util';
      const fills = {
        entry:   { bg: '#1E40AF', stroke: '#1E40AF', text: '#FFFFFF' },
        service: { bg: '#EFF6FF', stroke: '#1E40AF', text: '#1E40AF' },
        data:    { bg: '#FEF3C7', stroke: '#B45309', text: '#92400E' },
        config:  { bg: '#F3E8FF', stroke: '#7C3AED', text: '#5B21B6' },
        util:    { bg: '#F1F5F9', stroke: '#CBD5E1', text: '#334155' }
      };
      const c = fills[kind] || fills.util;
      svg += `<rect x="${x - 70}" y="${y - 18}" width="140" height="36" rx="10" fill="${c.bg}" stroke="${c.stroke}" stroke-width="1.5"/>`;
      svg += `<text x="${x}" y="${y + 4}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="${c.text}" font-weight="600">${escXml(truncate(node.label || node.id, 18))}</text>`;
    }

    svg += '</svg>';
    return svg;
  }

  function renderHeuristicFlow() {
    if (!S.hubs.length) return '<div class="empty">Not enough data for a flow diagram.</div>';
    const width = 800;
    const rowH = 130;
    const height = S.hubs.length * rowH + 40;

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="flow-svg" xmlns="http://www.w3.org/2000/svg">`;
    svg += '<defs><marker id="arrow-h2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94A3B8"/></marker></defs>';

    S.hubs.forEach((hub, i) => {
      const y = 40 + i * rowH;
      svg += `<rect x="10" y="${y - 14}" width="140" height="28" rx="14" fill="#EFF6FF" stroke="#1E40AF" stroke-width="1.5"/>`;
      svg += `<text x="80" y="${y + 4}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#1E40AF" font-weight="600">${escXml(truncate(hub.path.split('/').pop(), 16))}</text>`;

      const imports = ((S.files.get(hub.path) || {}).imports || []).slice(0, 3);
      imports.forEach((imp, j) => {
        const ty = y - 20 + j * 20;
        svg += `<line x1="150" y1="${y}" x2="370" y2="${ty}" stroke="#94A3B8" stroke-width="1" marker-end="url(#arrow-h2)"/>`;
        svg += `<rect x="370" y="${ty - 10}" width="160" height="20" rx="10" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="1"/>`;
        svg += `<text x="450" y="${ty + 4}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="#475569">${escXml(truncate(imp.split('/').pop(), 18))}</text>`;
      });
    });

    svg += '</svg>';
    return svg;
  }

  // ---- Tree ----
  function renderTree() {
    const root = { name: 'root', children: new Map(), files: [] };
    for (const p of S.files.keys()) {
      const parts = p.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.children.has(seg)) node.children.set(seg, { name: seg, children: new Map(), files: [] });
        node = node.children.get(seg);
      }
      node.files.push({ name: parts[parts.length - 1], path: p });
    }

    const flat = [];
    (function walk(node, path, depth) {
      if (depth > 3) return;
      for (const [name, child] of node.children) {
        flat.push({ name, path: path ? path + '/' + name : name, depth, isDir: true });
        walk(child, path ? path + '/' + name : name, depth + 1);
      }
      for (const f of node.files) {
        flat.push({ name: f.name, path: f.path, depth, isDir: false });
      }
    })(root, '', 0);

    const visible = flat.slice(0, 100);
    const rowH = 26, colW = 200, padding = 40;
    const height = visible.length * rowH + padding * 2;
    const maxDepth = Math.max.apply(null, visible.map(n => n.depth).concat([0]));
    const width = Math.max(600, (maxDepth + 1) * colW + padding * 2);

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="tree-svg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMinYMin meet">`;
    svg += `<circle cx="${padding}" cy="${padding}" r="6" fill="#1E40AF"/>`;
    svg += `<text x="${padding + 14}" y="${padding + 4}" font-family="ui-monospace, monospace" font-size="11" fill="#0F172A" font-weight="700">repo root</text>`;

    visible.forEach((node, i) => {
      const x = padding + (node.depth + 1) * colW;
      const y = padding + 30 + i * rowH;
      const cls = !node.isDir ? ((S.files.get(node.path) || {}).class || 'Other').toLowerCase() : '';
      svg += `<line x1="${x - 30}" y1="${y}" x2="${x - 8}" y2="${y}" stroke="#E2E8F0" stroke-width="1" class="tree-edge"/>`;
      svg += `<line x1="${x - 30}" y1="${y - rowH / 2}" x2="${x - 30}" y2="${y}" stroke="#E2E8F0" stroke-width="1" class="tree-edge"/>`;
      svg += `<circle cx="${x}" cy="${y}" r="${node.isDir ? 4 : 3}" fill="${node.isDir ? '#1E40AF' : '#94A3B8'}" class="tree-node class-${cls}"/>`;
      svg += `<text x="${x + 10}" y="${y + 3}" font-family="ui-monospace, monospace" font-size="10" fill="${node.isDir ? '#1E40AF' : '#475569'}" font-weight="${node.isDir ? '600' : '400'}" class="tree-label">${escXml(truncate(node.name, 26))}</text>`;
    });

    if (flat.length > visible.length) {
      svg += `<text x="${padding}" y="${height - 15}" font-family="-apple-system, sans-serif" font-size="10" fill="#94A3B8">+ ${flat.length - visible.length} more nodes</text>`;
    }
    svg += '</svg>';
    return svg;
  }

  function animateTree() {
    const container = document.getElementById('insights-tree-container');
    if (!container) return;
    const nodes = container.querySelectorAll('.tree-node');
    const labels = container.querySelectorAll('.tree-label');
    const edges = container.querySelectorAll('.tree-edge');
    const all = [].concat([...nodes], [...labels], [...edges]);
    all.forEach(el => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
    });
    let i = 0;
    function step() {
      if (i >= nodes.length) return;
      if (nodes[i]) nodes[i].style.opacity = '1';
      if (labels[i]) labels[i].style.opacity = '1';
      if (edges[i * 2]) edges[i * 2].style.opacity = '1';
      if (edges[i * 2 + 1]) edges[i * 2 + 1].style.opacity = '1';
      i++;
      setTimeout(step, 15 + i * 0.5);
    }
    setTimeout(step, 400);
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  window.ERplorerInsights = {
    refresh,
    reanalyze: function () {
      const digest = buildDigest();
      const hash = hashDigest(digest);
      try { localStorage.removeItem(CACHE_PREFIX + hash); } catch (e) {}
      refresh();
    },
    getDigest: function () { return S.digest; },
    state: function () {
      return {
        fileCount: S.files.size,
        hasAI: !!S.ai,
        aiPending: S.aiPending,
        aiError: S.aiError
      };
    }
  };
})();