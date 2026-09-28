/**
 * ERplorer — Error Resolution Explorer
 * Main application module.
 *
 * Depends on:
 *   - window.ERPLORER_CONFIG (erplorer.config.js)
 *   - FlexSearch (loaded in index.html)
 *   - SheetJS (loaded in index.html)
 *
 * Lazy-loads on demand:
 *   - html2canvas
 *   - jsPDF
 *   - Tesseract.js
 *   - Octokit (no longer used — replaced by raw CDN fetch)
 *
 * Exposes:
 *   - window.ERplorer.* — see PUBLIC API at the bottom
 *
 * Side effects:
 *   - Populates window._erplorerFileContents (Map<path, content>) during scan
 *   - Triggers window.ERplorerInsights.refresh() after index changes
 *   - Delegates runner calls to window.ERplorerRunner
 */
(function () {
  'use strict';

  // ============================================================
  // CONFIG + DEFAULTS
  // ============================================================
  const DEFAULT_CONFIG = {
    version: '1.2.0',
    endpoints: {
      aiPrimary: 'https://ragina-crawler-ragina.vercel.app/api/ask',
      aiFallback: 'https://text.pollinations.ai/openai',
      crawl: 'https://ragina-crawler-ragina.vercel.app/api/crawl'
    },
    features: {
      errorDNA: true, fixRecipe: true, blastRadius: true,
      screenshot: true, pdfReport: true, ocr: true,
      chat: true, shareLink: true, bugReport: true, runner: true
    },
    webhooks: {},
    mcp: { enabled: false, serverUrl: '', name: 'erplorer', tools: [] },
    runner: { baseUrl: 'http://localhost:8787' },
    cdn: {
      html2canvas: 'https://esm.sh/html2canvas@1.4.1',
      jspdf: 'https://esm.sh/jspdf@2.5.1',
      tesseract: 'https://esm.sh/tesseract.js@5.0.4'
    },
    ui: { defaultTheme: 'light', itemsPerPage: 25, showUSPBanner: true }
  };

  const CONFIG = Object.assign({}, DEFAULT_CONFIG, window.ERPLORER_CONFIG || {});
  CONFIG.endpoints = Object.assign({}, DEFAULT_CONFIG.endpoints, (window.ERPLORER_CONFIG || {}).endpoints || {});
  CONFIG.features = Object.assign({}, DEFAULT_CONFIG.features, (window.ERPLORER_CONFIG || {}).features || {});
  CONFIG.cdn = Object.assign({}, DEFAULT_CONFIG.cdn, (window.ERPLORER_CONFIG || {}).cdn || {});
  CONFIG.ui = Object.assign({}, DEFAULT_CONFIG.ui, (window.ERPLORER_CONFIG || {}).ui || {});
  CONFIG.runner = Object.assign({}, DEFAULT_CONFIG.runner, (window.ERPLORER_CONFIG || {}).runner || {});

  // ============================================================
  // STATE
  // ============================================================
  const DB_NAME = 'erplorer';
  const DB_VERSION = 1;
  const HISTORY_LIMIT = 25;

  let dbPromise = null;
  let documents = [];
  let flexIndex = null;
  let activeFilter = 'all';
  let customPatterns = [];
  let currentRows = [];
  let ingestCount = 0;
  let currentResults = {};

  // Lazy-loaded libs
  let html2canvasMod = null;
  let jsPdfMod = null;
  let tesseractMod = null;

  // Full file contents captured during scan — consumed by Insights
  window._erplorerFileContents = window._erplorerFileContents || new Map();

  // Abort controller for in-flight repo scan
  let _repoScanController = null;

  // ============================================================
  // HELPERS
  // ============================================================
  const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  /**
   * Accepts a raw.githubusercontent.com URL or a github.com blob URL
   * and returns { rawUrl, owner, repo, branch, filePath } or null.
   */
  function parseGithubUrlToRaw(url) {
    url = String(url || '').trim();
    let m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      return { rawUrl: url, owner: m[1], repo: m[2], branch: m[3], filePath: m[4] };
    }
    m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (m) {
      const owner = m[1], repo = m[2], branch = m[3], filePath = m[4];
      return {
        rawUrl: 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath,
        owner: owner, repo: repo, branch: branch, filePath: filePath
      };
    }
    return null;
  }

  /**
   * Parse "owner/repo", "owner/repo#branch", or a github.com URL.
   */
  function parseRepoSpec(input) {
    let s = String(input || '').trim();
    s = s.replace(/^https?:\/\/github\.com\//i, '');
    s = s.replace(/\.git$/i, '');
    let branch = null;
    if (s.includes('#')) {
      const idx = s.indexOf('#');
      branch = s.slice(idx + 1).trim() || null;
      s = s.slice(0, idx);
    }
    const parts = s.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1], branch: branch };
  }

  /**
   * Thin wrapper around the GitHub REST API.
   */
  async function githubApi(path, token, signal) {
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('https://api.github.com' + path, { headers: headers, signal: signal });
    if (res.status === 404) throw new Error('404');
    if (res.status === 403 || res.status === 429) throw new Error('rate-limited');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /**
   * Fetch a raw file with CDN fallback.
   */
  async function fetchRawFile(owner, repo, branch, path, signal) {
    const raw = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + path;
    const cdn = 'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + branch + '/' + path;
    try {
      const res = await fetch(raw, { signal: signal });
      if (res.ok) return await res.text();
    } catch (e) { /* fall through */ }
    try {
      const res = await fetch(cdn, { signal: signal });
      if (res.ok) return await res.text();
    } catch (e) { /* both failed */ }
    return null;
  }

  /**
   * Detect the default branch with cache.
   */
  async function detectDefaultBranch(owner, repo, token, signal) {
    const cacheKey = 'erplorer_branch_' + owner + '_' + repo;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;

    try {
      const info = await githubApi('/repos/' + owner + '/' + repo, token, signal);
      if (info.default_branch) {
        localStorage.setItem(cacheKey, info.default_branch);
        return info.default_branch;
      }
    } catch (e) { /* fall through */ }

    const candidates = ['main', 'master', 'develop', 'trunk'];
    for (const branch of candidates) {
      try {
        const probe = 'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + branch + '/README.md';
        const res = await fetch(probe, { method: 'HEAD', signal: signal });
        if (res.ok) {
          localStorage.setItem(cacheKey, branch);
          return branch;
        }
      } catch (e) { /* try next */ }
    }
    throw new Error('could not detect a default branch (tried main, master, develop, trunk)');
  }

  /**
   * List all files in the repo.
   */
  async function listRepoFiles(owner, repo, branch, token, signal) {
    try {
      const tree = await githubApi(
        '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1',
        token, signal
      );
      if (tree && Array.isArray(tree.tree)) {
        return tree.tree.filter(f => f.type === 'blob' && (!f.size || f.size < 500000));
      }
    } catch (e) { /* fall through to jsDelivr */ }

    const res = await fetch('https://data.jsdelivr.com/v1/packages/gh/' + owner + '/' + repo + '@' + branch, { signal: signal });
    if (!res.ok) throw new Error('could not list files: both GitHub API and jsDelivr failed');
    const data = await res.json();
    const out = [];
    (function walk(nodes, prefix) {
      for (const n of nodes || []) {
        const p = prefix ? prefix + '/' + n.name : n.name;
        if (n.type === 'directory' && n.files) walk(n.files, p);
        else if (n.type === 'file') out.push({ path: p, type: 'blob', size: n.size });
      }
    })(data.files, '');
    return out.filter(f => !f.size || f.size < 500000);
  }

  /**
   * Fetch N items with limited concurrency.
   */
  async function parallelMap(items, concurrency, fn, onProgress) {
    const results = new Array(items.length);
    let index = 0;
    let completed = 0;

    async function worker() {
      while (index < items.length) {
        const i = index++;
        try { results[i] = await fn(items[i], i); }
        catch (e) { results[i] = null; }
        completed++;
        if (onProgress) onProgress(completed, items.length);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
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

  function toast(msg, dur) {
    dur = dur || 2200;
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), dur);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); return true; }
      catch (e2) { return false; }
      finally { document.body.removeChild(ta); }
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    timeoutMs = timeoutMs || 45000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // INDEXEDDB
  // ============================================================
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('searches')) {
          const s = db.createObjectStore('searches', { keyPath: 'id', autoIncrement: true });
          s.createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('patterns')) {
          const p = db.createObjectStore('patterns', { keyPath: 'id', autoIncrement: true });
          p.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
    return dbPromise;
  }

  async function dbAdd(store, v) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const r = tx.objectStore(store).add(v);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbGetAll(store) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const r = tx.objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbDelete(store, id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const r = tx.objectStore(store).delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
  async function dbClear(store) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const r = tx.objectStore(store).clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }

  // ============================================================
  // WEBHOOKS
  // ============================================================
  async function dispatchWebhook(event, payload) {
    const hooks = CONFIG.webhooks || {};
    for (const name of Object.keys(hooks)) {
      const hook = hooks[name];
      if (!hook || !hook.enabled || !hook.url) continue;
      const events = hook.events || [];
      if (!events.includes(event)) continue;

      let body;
      if (name === 'slack') {
        body = { text: '*ERplorer — ' + event + '*\n```' + JSON.stringify(payload, null, 2) + '```', channel: hook.channel };
      } else if (name === 'teams') {
        body = { text: 'ERplorer — ' + event, sections: [{ text: JSON.stringify(payload) }] };
      } else if (name === 'discord') {
        body = { content: '**ERplorer — ' + event + '**\n```\n' + JSON.stringify(payload, null, 2).slice(0, 1800) + '\n```' };
      } else {
        body = { event: event, payload: payload, timestamp: Date.now(), source: 'erplorer' };
      }

      try {
        await fetch(hook.url, {
          method: hook.method || 'POST',
          headers: hook.headers || { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        console.log('[webhook] ' + name + ' fired for ' + event);
      } catch (err) {
        console.warn('[webhook] ' + name + ' failed:', err.message);
      }
    }
  }

  // ============================================================
  // MCP CHECK
  // ============================================================
  async function checkMCP() {
    if (!CONFIG.mcp || !CONFIG.mcp.enabled || !CONFIG.mcp.serverUrl) return;
    try {
      const res = await fetch(CONFIG.mcp.serverUrl + '/health', { method: 'GET' });
      console.log('[mcp] status:', res.ok ? 'reachable' : 'responded ' + res.status);
    } catch (err) {
      console.warn('[mcp] unreachable:', err.message);
    }
  }

  // ============================================================
  // THEME
  // ============================================================
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('erplorer_theme', t);
    const lb = document.getElementById('theme-light-btn');
    const db = document.getElementById('theme-dark-btn');
    if (lb) lb.classList.toggle('active', t === 'light');
    if (db) db.classList.toggle('active', t === 'dark');
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(cur === 'dark' ? 'light' : 'dark');
  }
  function initTheme() {
    const saved = localStorage.getItem('erplorer_theme') || CONFIG.ui.defaultTheme || 'light';
    setTheme(saved);
  }

  // ============================================================
  // NAVIGATION
  // ============================================================
  function initNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById('panel-' + btn.dataset.panel);
        if (panel) panel.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });

    document.querySelectorAll('.subtab').forEach(t => {
      t.addEventListener('click', () => {
        if (!t.dataset.lab) return;
        document.querySelectorAll('.subtab[data-lab]').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        const sc = document.getElementById('lab-scenarios');
        const sp = document.getElementById('lab-specs');
        if (sc) sc.style.display = t.dataset.lab === 'scenarios' ? 'block' : 'none';
        if (sp) sp.style.display = t.dataset.lab === 'specs' ? 'block' : 'none';
      });
    });
  }

  // ============================================================
  // ERROR DNA
  // ============================================================
  function fingerprint(msg) {
    return String(msg || '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<DATE>')
      .replace(/'[^']*'/g, "'<STR>'")
      .replace(/"[^"]*"/g, '"<STR>"')
      .replace(/\b\d+\b/g, '<N>')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function dnaCluster(hits) {
    const clusters = new Map();
    for (const h of hits) {
      const doc = documents[h.id];
      if (!doc) continue;
      const fp = fingerprint(doc.text || '');
      if (!clusters.has(fp)) clusters.set(fp, []);
      clusters.get(fp).push(doc);
    }
    return clusters;
  }

  // ============================================================
  // FIX RECIPE
  // ============================================================
  const FIX_RECIPES = [
    { match: /cannot read propert(y|ies)\s+['"]?(\w+)['"]?\s+of\s+(undefined|null)/i,
      recipe: m => 'Guard the parent object before accessing .' + m[2] + '. Likely fix:\n  if (!parent) return;\n  parent.' + m[2] + '...\nOr use optional chaining: parent?.' + m[2] },
    { match: /(\w+) is not a function/i,
      recipe: m => 'The value "' + m[1] + '" is not callable. Check imports, or a variable shadowed the function name.' },
    { match: /(\w+) is not defined/i,
      recipe: m => '"' + m[1] + '" was never declared. Check for a typo, missing import, or different scope.' },
    { match: /unexpected token/i,
      recipe: () => 'Syntax error — check for a missing bracket, comma, or quote on the line just before.' },
    { match: /timeout|timed out/i,
      recipe: () => 'Operation exceeded timeout. Common causes: slow network, blocking sync code, or a selector that never appears.' },
    { match: /nullpointerexception/i,
      recipe: () => 'A null value was dereferenced. Add a null check, or use Optional<> in Java.' },
    { match: /table or view not found|table_?or_?view_?not_?found/i,
      recipe: () => 'The table doesn\'t exist in this catalog/schema. Check the fully qualified name.' },
    { match: /unresolved column|column not found/i,
      recipe: () => 'Column doesn\'t exist. Verify spelling and check schema version.' },
    { match: /division by zero|divide by zero/i,
      recipe: () => 'Denominator was 0. Add a guard, or use NULLIF(denominator, 0) in SQL.' },
    { match: /no such file or directory|filenotfounderror/i,
      recipe: () => 'File path is wrong or file doesn\'t exist. Check working directory.' },
    { match: /permission denied|eacces/i,
      recipe: () => 'Process lacks read/write/exec permission. Check file mode and owner.' },
    { match: /unauthorized|401|invalid.*token/i,
      recipe: () => 'Authentication failed. Token may be expired, malformed, or missing scopes.' },
    { match: /forbidden|403/i,
      recipe: () => 'Authenticated but not authorized. Check role assignments and resource policies.' },
    { match: /cannot find module|module not found/i,
      recipe: () => 'Missing dependency. Run install, check spelling, verify it\'s in package.json.' },
    { match: /keyerror/i,
      recipe: () => 'Dict key doesn\'t exist. Use .get(key, default) or check with "in" first.' },
    { match: /indexerror|list index out of range/i,
      recipe: () => 'Index outside list bounds. Verify length before accessing.' }
  ];

  function getFixRecipe(text) {
    if (!text) return null;
    for (const entry of FIX_RECIPES) {
      const m = text.match(entry.match);
      if (m) {
        return {
          matched: m[0],
          suggestion: typeof entry.recipe === 'function' ? entry.recipe(m) : entry.recipe
        };
      }
    }
    return null;
  }

  // ============================================================
  // BLAST RADIUS
  // ============================================================
  const STOP_WORDS = new Set(['the','and','for','with','from','this','that','null','undefined','true','false','value','error','string','number','object','function']);

  function extractIdentifiers(text) {
    if (!text) return [];
    const ids = new Set();
    const matches = text.match(/\b[A-Za-z_][\w]{2,}\b/g) || [];
    for (const m of matches) {
      if (STOP_WORDS.has(m.toLowerCase())) continue;
      if (/^\d/.test(m)) continue;
      ids.add(m);
    }
    return Array.from(ids);
  }

  function findBlastRadius(doc) {
    const ids = extractIdentifiers(doc.text || '').slice(0, 5);
    if (!ids.length) return [];
    const refs = new Map();
    for (const id of ids) {
      for (let i = 0; i < documents.length; i++) {
        const other = documents[i];
        if (other === doc || other.file === doc.file) continue;
        if (other.text && other.text.includes(id)) {
          if (!refs.has(other.file)) refs.set(other.file, new Set());
          refs.get(other.file).add(id);
        }
      }
    }
    return Array.from(refs.entries()).slice(0, 5).map(entry => ({ file: entry[0], ids: Array.from(entry[1]) }));
  }

  // ============================================================
  // LOAD INDEX
  // ============================================================
  async function loadIndex() {
    try {
      const res = await fetch('search-index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      documents = await res.json();
      flexIndex = new FlexSearch.Document({
        document: { id: 'id', index: ['text'], store: true },
        tokenize: 'forward', resolution: 9, cache: true
      });
      documents.forEach((doc, i) => flexIndex.add(Object.assign({}, doc, { id: i })));
      renderStats();
      renderChips();
      handleInboundShareLink();

      // Refresh Insights with whatever contents we've captured so far
      if (window.ERplorerInsights && typeof window.ERplorerInsights.refresh === 'function') {
        try { window.ERplorerInsights.refresh(); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      const el = document.getElementById('stat-row');
      if (el) el.innerHTML = '<div class="status-line warn">No search-index.json yet. Add content via <strong>Ingest</strong>.</div>';
      documents = [];
    }
  }

  function handleInboundShareLink() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const q = hash.get('q');
    if (!q) return;
    const navBtn = document.querySelector('.nav-item[data-panel="search"]');
    if (navBtn) navBtn.click();
    const si = document.getElementById('search-input');
    if (si) si.value = q;
    if (hash.get('f')) activeFilter = hash.get('f');
    renderChips();
    runSearch();
  }

  function renderStats() {
    const files = new Set(documents.map(d => d.file)).size;
    const thrown = documents.filter(d => d.type && d.type.includes('error')).length;
    const tests = documents.filter(d => d.type === 'test-failure').length;
    const el = document.getElementById('stat-row');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><span class="num">' + files + '</span><span class="lbl">files</span></div>' +
      '<div class="stat"><span class="num">' + documents.length + '</span><span class="lbl">entries</span></div>' +
      '<div class="stat"><span class="num">' + thrown + '</span><span class="lbl">thrown</span></div>' +
      '<div class="stat"><span class="num">' + tests + '</span><span class="lbl">tests</span></div>';
  }

  function renderChips() {
    const counts = { all: documents.length };
    for (const d of documents) {
      const t = d.type || 'code';
      counts[t] = (counts[t] || 0) + 1;
    }
    const order = ['all','error','java-error','python-error','sql-error','config-error','test-failure','crawled','custom-error'];
    const labels = { all:'All','error':'Errors','java-error':'Java','python-error':'Python','sql-error':'SQL','config-error':'Config','test-failure':'Tests','crawled':'Crawled','custom-error':'Custom' };
    const el = document.getElementById('filter-chips');
    if (!el) return;
    el.innerHTML = order.filter(k => counts[k]).map(k =>
      '<button class="chip ' + (k === activeFilter ? 'active' : '') + '" onclick="ERplorer.setFilter(\'' + k + '\')">' +
      (labels[k] || k) + ' <span class="count">' + counts[k] + '</span></button>'
    ).join('');
  }

  function setFilter(f) {
    activeFilter = f;
    renderChips();
    const si = document.getElementById('search-input');
    if (si && si.value.trim().length >= 2) runSearch();
  }

  // ============================================================
  // SEARCH
  // ============================================================
  function initSearch() {
    const si = document.getElementById('search-input');
    if (!si) return;
    let debounce;
    si.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(), 180);
    });
    si.addEventListener('keydown', e => {
      if (e.key === 'Enter') { clearTimeout(debounce); runSearch(true); }
    });
  }

  function runSearch(save) {
    const si = document.getElementById('search-input');
    const el = document.getElementById('results');
    if (!si || !el) return;
    const q = si.value.trim();
    if (q.length < 2) { el.innerHTML = ''; toggleResultsActions(false); return; }

    const raw = flexIndex ? flexIndex.search(q, { enrich: true }) : [];
    let hits = raw.flatMap(r => r.result);
    if (activeFilter !== 'all') hits = hits.filter(h => documents[h.id] && documents[h.id].type === activeFilter);

    if (!hits.length) {
      el.innerHTML = '<div class="empty">No matches found.</div>';
      toggleResultsActions(false);
      if (save) recordSearch(q, 'exact', 0);
      return;
    }

    const clusters = dnaCluster(hits);
    const rendered = [];
    const seenFiles = new Set();
    for (const entry of clusters.values()) {
      const rep = entry[0];
      const key = rep.file + ':' + rep.line;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      rendered.push({ doc: rep, count: entry.length });
      if (rendered.length >= CONFIG.ui.itemsPerPage) break;
    }

    currentResults = {};
    el.innerHTML = rendered.map(item => renderResult(item.doc, q, item.count)).join('');
    toggleResultsActions(true);
    if (save) recordSearch(q, 'exact', hits.length);
  }

  function toggleResultsActions(show) {
    const el = document.getElementById('results-actions');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  function renderResult(doc, query, dnaCount) {
    dnaCount = dnaCount || 1;
    const lines = (doc.context || doc.text || '').split('\n');
    const codeLines = lines.map((line, i) => {
      const num = (doc.line || 1) - Math.floor(lines.length / 2) + i;
      const isHit = query && line.toLowerCase().includes(query.toLowerCase());
      const text = isHit
        ? escapeHtml(line).replace(new RegExp('(' + escapeRegex(query) + ')', 'gi'), '<span class="mark">$1</span>')
        : escapeHtml(line);
      return '<div class="code-line ' + (isHit ? 'hit' : '') + '"><span class="code-num">' + num + '</span><span class="code-text">' + text + '</span></div>';
    }).join('');

    const type = doc.type || 'code';
    const recipe = CONFIG.features.fixRecipe ? getFixRecipe(doc.text || '') : null;
    const blast = CONFIG.features.blastRadius ? findBlastRadius(doc) : [];
    const docId = slug(doc.file + '_' + (doc.line || 0)) + '_' + Math.random().toString(36).slice(2, 6);
    currentResults[docId] = doc;

    return '' +
      '<div class="result">' +
        '<div class="result-head">' +
          '<div class="result-file"><strong>' + escapeHtml(doc.file || 'unknown') + '</strong>' + (doc.line ? ':' + doc.line : '') + '</div>' +
          '<div class="result-badges">' +
            ((CONFIG.features.errorDNA && dnaCount > 1) ? '<span class="result-badge dna">🧬 ×' + dnaCount + '</span>' : '') +
            '<span class="result-badge ' + type + '">' + type.replace('-error', '').replace('-failure', '') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="result-msg">' + escapeHtml(doc.text || '') + '</div>' +
        (codeLines ? '<div class="code-block">' + codeLines + '</div>' : '') +
        (recipe ? '<div class="fix-recipe"><div class="label">🔧 Fix Recipe</div><div class="recipe">' + escapeHtml(recipe.suggestion).replace(/\n/g, '<br>') + '</div></div>' : '') +
        (blast.length ? '<div class="blast-radius"><span>💥 <strong>Blast radius:</strong> also referenced in ' + blast.length + ' other file' + (blast.length === 1 ? '' : 's') + '</span><div class="blast-files">' + blast.map(b => '<span class="blast-file">' + escapeHtml(b.file) + '</span>').join('') + '</div></div>' : '') +
        '<div class="result-actions">' +
          '<button class="result-action" onclick="ERplorer.copyBugReport(\'' + docId + '\')">' +
            '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> Copy Bug Report' +
          '</button>' +
          '<button class="result-action" onclick="ERplorer.copyShareLink()">' +
            '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Share Link' +
          '</button>' +
          '<button class="result-action" onclick="ERplorer.copyFilePath(\'' + escapeHtml(doc.file || '') + '\', ' + (doc.line || 0) + ')">' +
            '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Copy path:line' +
          '</button>' +
        '</div>' +
      '</div>';
  }

  // ============================================================
  // BUG REPORT / SHARE / FILE PATH
  // ============================================================
  function buildBugReport(doc, recipe) {
    const loc = (doc.file || 'unknown') + (doc.line ? ':' + doc.line : '');
    const type = (doc.type || 'code').replace('-', ' ');
    let md = '# Bug Report\n\n**Type:** ' + type + '\n**Location:** `' + loc + '`\n\n';
    md += '## Error\n\n```\n' + (doc.text || '(no message)') + '\n```\n\n';
    if (doc.context) md += '## Context\n\n```\n' + doc.context + '\n```\n\n';
    if (recipe) md += '## Suggested fix\n\n' + recipe.suggestion + '\n\n';
    md += '## Repro\n\n1. Reproduce the failing path that leads to `' + loc + '`.\n2. Observe the error above.\n\n---\n_Generated by ERplorer_';
    return md;
  }

  async function copyBugReport(docId) {
    const doc = currentResults[docId];
    if (!doc) return;
    const recipe = getFixRecipe(doc.text || '');
    const report = buildBugReport(doc, recipe);
    const ok = await copyToClipboard(report);
    toast(ok ? '📋 Bug report copied' : '⚠️ Copy failed');
    if (ok) dispatchWebhook('bug.created', { file: doc.file, line: doc.line, type: doc.type, text: doc.text });
  }

  async function copyShareLink() {
    const si = document.getElementById('search-input');
    const q = si ? si.value.trim() : '';
    const url = location.origin + location.pathname + '#q=' + encodeURIComponent(q) + '&f=' + encodeURIComponent(activeFilter);
    const ok = await copyToClipboard(url);
    toast(ok ? '🔗 Share link copied' : '⚠️ Copy failed');
  }

  async function copyFilePath(file, line) {
    const ok = await copyToClipboard(file + (line ? ':' + line : ''));
    toast(ok ? '📁 Path copied' : '⚠️ Copy failed');
  }

  async function copyAllResults() {
    const parts = Object.values(currentResults).map(doc => {
      const recipe = getFixRecipe(doc.text || '');
      return buildBugReport(doc, recipe);
    });
    if (!parts.length) return;
    const ok = await copyToClipboard(parts.join('\n\n---\n\n'));
    toast(ok ? '📋 Copied ' + parts.length + ' report' + (parts.length === 1 ? '' : 's') : '⚠️ Copy failed');
  }

  // ============================================================
  // HISTORY
  // ============================================================
  async function recordSearch(query, mode, count) {
    if (!query || query.length < 2) return;
    try {
      const all = await dbGetAll('searches');
      for (const s of all) {
        if (s.query === query && s.mode === mode) await dbDelete('searches', s.id);
      }
      await dbAdd('searches', { query: query, mode: mode, resultCount: count, timestamp: Date.now() });
      const cur = await dbGetAll('searches');
      if (cur.length > HISTORY_LIMIT) {
        cur.sort((a, b) => a.timestamp - b.timestamp);
        for (const s of cur.slice(0, cur.length - HISTORY_LIMIT)) await dbDelete('searches', s.id);
      }
      renderHistory();
    } catch (err) { console.warn('history save:', err); }
  }

  async function renderHistory() {
    const wrap = document.getElementById('history-wrap');
    const list = document.getElementById('history-list');
    if (!wrap || !list) return;
    try {
      const all = await dbGetAll('searches');
      if (!all.length) { wrap.style.display = 'none'; return; }
      all.sort((a, b) => b.timestamp - a.timestamp);
      wrap.style.display = 'block';
      list.innerHTML = all.slice(0, 8).map(s =>
        '<button class="chip" onclick="ERplorer.rerunSearch(' + s.id + ')">' +
          escapeHtml(s.query.length > 32 ? s.query.slice(0, 32) + '…' : s.query) +
          ' <span class="count">' + (s.resultCount != null ? s.resultCount : '—') + '</span>' +
        '</button>'
      ).join('');
    } catch (err) { console.warn('history render:', err); }
  }

  async function rerunSearch(id) {
    const all = await dbGetAll('searches');
    const entry = all.find(s => s.id === id);
    if (!entry) return;
    if (entry.mode === 'ai') {
      const nav = document.querySelector('.nav-item[data-panel="ask"]');
      if (nav) nav.click();
      const ni = document.getElementById('nl-input');
      if (ni) ni.value = entry.query;
      askNatural();
    } else {
      const nav = document.querySelector('.nav-item[data-panel="search"]');
      if (nav) nav.click();
      const si = document.getElementById('search-input');
      if (si) si.value = entry.query;
      runSearch();
    }
  }

  async function clearHistory() {
    try { await dbClear('searches'); renderHistory(); }
    catch (err) { console.warn(err); }
  }

  // ============================================================
  // ASK / CHAT
  // ============================================================
  function pushChat(role, content, isHtml) {
    const thread = document.getElementById('chat-thread');
    if (!thread) return null;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (role === 'user' ? 'user' : 'ai');
    if (role === 'ai' && isHtml) bubble.innerHTML = content;
    else bubble.textContent = content;
    thread.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return bubble;
  }

  function pushTyping() {
    const thread = document.getElementById('chat-thread');
    if (!thread) return null;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ai';
    bubble.innerHTML = '<div class="ai-src">ERplorer</div><div class="typing-dots"><span></span><span></span><span></span></div>';
    thread.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return bubble;
  }

  function quickAsk(text) {
    const ni = document.getElementById('nl-input');
    if (ni) ni.value = text;
    askNatural();
  }

  async function askNatural() {
    const ni = document.getElementById('nl-input');
    if (!ni) return;
    const q = ni.value.trim();
    if (!q) return;
    ni.value = '';

    pushChat('user', q);
    const typing = pushTyping();

    if (!documents.length) {
      if (typing) typing.remove();
      pushChat('ai', '<div class="ai-src">ERplorer</div>Index is empty. Add content via the Ingest tab first.', true);
      return;
    }

    const raw = flexIndex ? flexIndex.search(q, { enrich: true }) : [];
    const hits = raw.flatMap(r => r.result).slice(0, 8).map(h => documents[h.id]).filter(Boolean);

    if (!hits.length) {
      if (typing) typing.remove();
      pushChat('ai', '<div class="ai-src">ERplorer</div>No matching entries. Try different keywords or use the <strong>Search</strong> tab.', true);
      return;
    }

    const context = hits.map((d, i) =>
      '[' + (i + 1) + '] ' + d.file + (d.line ? ':' + d.line : '') + ' (' + (d.type || 'code') + ')\n' +
      (d.text || '').slice(0, 300)
    ).join('\n\n');
    const prompt = 'User query: "' + q + '"\n\nTop matching entries:\n\n' + context + '\n\nGive a short answer for a QA engineer. Cite sources as [1], [2] etc. Under 150 words.';

    let answer = '';
    let source = '';
    try {
      const res = await fetchWithTimeout(CONFIG.endpoints.aiPrimary, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: prompt, context: 'QA assistant' })
      });
      if (res.ok) {
        const data = await res.json();
        answer = data.answer || data.content || data.response
          || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        if (answer) source = 'Vercel';
      }
    } catch (err) { /* try fallback */ }

    if (!answer) {
      try {
        const res = await fetchWithTimeout(CONFIG.endpoints.aiFallback, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai',
            messages: [
              { role: 'system', content: 'Answer about codebase errors with [n] citations. Short and clear.' },
              { role: 'user', content: prompt }
            ]
          })
        });
        if (res.ok) {
          const d = await res.json();
          answer = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
          if (answer) source = 'Pollinations';
        }
      } catch (err) { /* offline */ }
    }

    if (typing) typing.remove();

    let html = '';
    if (answer) {
      html += '<div class="ai-src">' + escapeHtml(source) + '</div>';
      html += escapeHtml(answer).replace(/\n/g, '<br>');
    } else {
      html += '<div class="ai-src">ERplorer · offline mode</div>';
      html += 'AI endpoints are offline, but I found <strong>' + hits.length + '</strong> matching entries:';
    }
    html += '<div class="matches-head">Top matches</div>';
    html += hits.slice(0, 5).map((d, i) => {
      const recipe = CONFIG.features.fixRecipe ? getFixRecipe(d.text || '') : null;
      return '' +
        '<div class="chat-match">' +
          '<div class="f">[' + (i + 1) + '] ' + escapeHtml(d.file || 'unknown') + (d.line ? ':' + d.line : '') + '</div>' +
          '<div class="t">' + escapeHtml((d.text || '').slice(0, 200)) + '</div>' +
          (recipe ? '<div style="font-size:11px;color:var(--accent);margin-top:6px;font-weight:600;">🔧 ' + escapeHtml(recipe.suggestion.split('\n')[0]) + '</div>' : '') +
        '</div>';
    }).join('');

    pushChat('ai', html, true);
    recordSearch(q, 'ai', hits.length);
  }

  // ============================================================
  // LAB — scenarios
  // ============================================================
  const SAMPLE_SCENARIOS = 'Test the login page:\n' +
    '1. Go to /login\n' +
    '2. Enter "admin" in the username field\n' +
    '3. Enter "secret123" in the password field\n' +
    '4. Click the submit button\n' +
    '5. Verify that the dashboard shows "Welcome admin"\n\n' +
    'Test the users API:\n' +
    '- GET /api/users should return 200\n' +
    '- The first user\'s name should be "alice"';

  function loadSampleScenarios() {
    const el = document.getElementById('ai-input');
    if (el) el.value = SAMPLE_SCENARIOS;
  }

  async function runAITransform() {
    const input = document.getElementById('ai-input');
    const status = document.getElementById('ai-status');
    const preview = document.getElementById('ai-preview');
    if (!input || !status || !preview) return;

    const text = input.value.trim();
    if (!text) { status.innerHTML = '<div class="status-line err">Paste scenarios first.</div>'; return; }

    status.innerHTML = '<div class="status-line"><span class="spinner"></span>Asking AI…</div>';
    preview.innerHTML = '';

    const prompt = 'Convert these test scenarios into JSON. Output only {"steps":[...]} where each step has: id, scenario, step, action, method, url, headers, body, selector, value, expected, jsonpath. Actions: goto, fill, click, expectText, expectVisible, expectUrl, wait, apiRequest, expectStatus, expectJson, expectHeader, runSql, expectRowCount, expectNoNulls, expectUnique, expectValue.\n\nScenarios:\n' + text;

    let content = '';
    try {
      const res = await fetchWithTimeout(CONFIG.endpoints.aiPrimary, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: prompt, context: 'Output only valid JSON.' })
      });
      if (res.ok) {
        const d = await res.json();
        content = d.answer || d.content || d.response || '';
      }
    } catch (err) { /* fallback */ }

    if (!content) {
      try {
        const res = await fetchWithTimeout(CONFIG.endpoints.aiFallback, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'openai',
            messages: [
              { role: 'system', content: 'You output only valid JSON.' },
              { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
          })
        });
        if (res.ok) {
          const d = await res.json();
          content = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
        }
      } catch (err) { /* offline */ }
    }

    if (!content) {
      status.innerHTML = '<div class="status-line err">AI endpoints failed. Falling back to rules…</div>';
      setTimeout(runRuleTransform, 600);
      return;
    }

    try {
      const clean = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(clean);
      const steps = parsed.steps || parsed;
      if (!Array.isArray(steps) || !steps.length) throw new Error('No steps');
      renderScenarioTable(steps, 'AI');
    } catch (err) {
      status.innerHTML = '<div class="status-line warn">AI output unparseable. Falling back to rules…</div>';
      setTimeout(runRuleTransform, 600);
    }
  }

  function runRuleTransform() {
    const input = document.getElementById('ai-input');
    const status = document.getElementById('ai-status');
    if (!input || !status) return;
    const text = input.value.trim();
    if (!text) { status.innerHTML = '<div class="status-line err">Paste scenarios first.</div>'; return; }
    const steps = ruleBasedParse(text);
    if (!steps.length) { status.innerHTML = '<div class="status-line warn">No steps detected. Try numbered lists with verbs like go to, enter, click, verify.</div>'; return; }
    renderScenarioTable(steps, 'Rules');
  }

  function ruleBasedParse(text) {
    const rows = [];
    let id = 'TC001', scenario = 'Test scenario', stepNum = 0, tcCount = 0;
    for (const raw of text.split('\n')) {
      const cleaned = raw.trim().replace(/^[-*•]\s+/, '').replace(/^\d+[.):\]]\s*/, '').trim();
      if (!cleaned) continue;
      const tcMatch = cleaned.match(/TC\d+/i);
      const headMatch = cleaned.match(/^(test|scenario|verify)\s+(?:the\s+)?(.+?)(?::|\.|$)/i);
      if (tcMatch && cleaned.length < 80) {
        tcCount++; id = tcMatch[0].toUpperCase();
        scenario = cleaned.replace(tcMatch[0], '').replace(/[:\-]/g, '').trim() || scenario;
        stepNum = 0; continue;
      }
      if (headMatch && cleaned.length < 80 && !/^(go|enter|click|verify|wait|get|post|sql|run|select|expect)/i.test(cleaned)) {
        tcCount++; id = 'TC' + String(tcCount).padStart(3, '0');
        scenario = headMatch[2].trim(); stepNum = 0; continue;
      }
      const quoted = cleaned.match(/["']([^"']+)["']/);
      const sel = cleaned.match(/[#.][\w-]+|\[[\w-]+=[^\]]+\]/);
      let action = '', url = '', selector = '', value = '', expected = '', method = '';
      if (/^(go to|navigate to|open|visit)\s/i.test(cleaned)) {
        action = 'goto'; url = cleaned.replace(/^(go to|navigate to|open|visit)\s+/i, '').trim();
        const m = url.match(/https?:\/\/\S+|\/\S+/); if (m) url = m[0];
      } else if (/^(enter|type|input|fill)\s/i.test(cleaned)) {
        action = 'fill'; if (quoted) value = quoted[1];
        if (sel) selector = sel[0];
        else { const f = cleaned.match(/(?:in|into)\s+the\s+([\w-]+)/i); if (f) selector = '#' + f[1].toLowerCase(); }
      } else if (/^(click|press|tap)\s/i.test(cleaned)) {
        action = 'click'; if (sel) selector = sel[0]; else if (quoted) selector = 'text=' + quoted[1];
      } else if (/^(verify|check|expect|should see|should show|assert|confirm)\s/i.test(cleaned)) {
        action = 'expectText';
        if (quoted) expected = quoted[1];
        else expected = cleaned.replace(/^(verify|check|expect|should see|should show|assert|confirm)\s+(that\s+)?/i, '').trim();
      } else if (/^(get|post|put|delete|patch)\s+/i.test(cleaned)) {
        action = 'apiRequest';
        const m = cleaned.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)/i);
        if (m) { method = m[1].toUpperCase(); url = m[2]; }
      } else if (/should return\s+(\d+)/i.test(cleaned)) {
        action = 'expectStatus'; expected = cleaned.match(/should return\s+(\d+)/i)[1];
      } else if (/^sql[:\s]|^run sql|^select\s/i.test(cleaned)) {
        action = 'runSql'; value = cleaned.replace(/^(sql[:\s]+|run sql\s+)/i, '').trim();
      } else if (/no nulls in\s+([\w.]+)/i.test(cleaned)) {
        action = 'expectNoNulls'; selector = cleaned.match(/no nulls in\s+([\w.]+)/i)[1];
      } else if (/(\d+)\s+rows?/i.test(cleaned)) {
        action = 'expectRowCount'; expected = cleaned.match(/(\d+)\s+rows?/i)[1];
      }
      if (action) {
        stepNum++;
        rows.push({ id: id, scenario: scenario, step: String(stepNum), action: action, method: method, url: url, headers: '', body: '', selector: selector, value: value, expected: expected, jsonpath: '' });
      }
    }
    return rows;
  }

  function renderScenarioTable(rows, source) {
    currentRows = rows;
    const testCaseCount = new Set(rows.map(r => r.id)).size;
    const status = document.getElementById('ai-status');
    const preview = document.getElementById('ai-preview');
    if (!status || !preview) return;
    status.innerHTML = '<div class="status-line ok">' + source + ' produced ' + rows.length + ' steps across ' + testCaseCount + ' test case' + (testCaseCount === 1 ? '' : 's') + '.</div>';

    const cols = ['id','scenario','step','action','method','url','headers','body','selector','value','expected','jsonpath'];
    preview.innerHTML = '' +
      '<div style="overflow-x:auto; border-radius:var(--radius);">' +
        '<table class="data-table">' +
          '<thead><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr></thead>' +
          '<tbody>' +
            rows.map((r, i) =>
              '<tr data-row="' + i + '">' +
                cols.map(c => '<td contenteditable="true" data-col="' + c + '">' + escapeHtml(String(r[c] || '')) + '</td>').join('') +
              '</tr>'
            ).join('') +
          '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="row" style="margin-top:14px;">' +
        '<button class="btn" onclick="ERplorer.generateFromRows()">Generate specs</button>' +
        '<button class="btn accent" onclick="ERplorer.runScenariosViaRunner()">▶ Run now</button>' +
        '<button class="btn secondary" onclick="ERplorer.downloadRows(\'csv\')">Download CSV</button>' +
        '<button class="btn secondary" onclick="ERplorer.downloadRows(\'xlsx\')">Download XLSX</button>' +
      '</div>' +
      '<div id="ai-run-output"></div>';

    preview.querySelectorAll('td[contenteditable]').forEach(td => {
      td.addEventListener('blur', () => {
        const i = parseInt(td.closest('tr').dataset.row, 10);
        currentRows[i][td.dataset.col] = td.textContent.trim();
      });
    });
  }

  function downloadRows(format) {
    if (!currentRows.length) return;
    const cols = ['id','scenario','step','action','method','url','headers','body','selector','value','expected','jsonpath'];
    const csvEscape = v => {
      const s = String(v == null ? '' : v);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    };
    if (format === 'csv') {
      const body = [cols.join(','), ...currentRows.map(r => cols.map(c => csvEscape(r[c])).join(','))].join('\n');
      downloadFile('ai-test-cases.csv', body, 'text/csv');
    } else {
      const aoa = [cols, ...currentRows.map(r => cols.map(c => String(r[c] || '')))];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'TestCases');
      XLSX.writeFile(wb, 'ai-test-cases.xlsx');
    }
  }

  function generateFromRows() {
    const tab = document.querySelector('.subtab[data-lab="specs"]');
    if (tab) tab.click();
    renderSpecs(currentRows, 'AI-generated');
  }

  function getCurrentRows() {
    return currentRows;
  }

  // ============================================================
  // LAB — run via runner (Playwright + real HTTP)
  // ============================================================
  async function runScenariosViaRunner() {
    if (!window.ERplorerRunner) {
      toast('Runner client not loaded');
      return;
    }
    if (!currentRows.length) {
      toast('Generate scenarios first');
      return;
    }

    const status = document.getElementById('ai-status');
    const out = document.getElementById('ai-run-output');
    if (out) out.innerHTML = '';

    const ok = await window.ERplorerRunner.isAvailable();
    if (!ok) {
      if (status) status.innerHTML =
        '<div class="status-line warn">⚠️ Runner offline. Start it with ' +
        '<code>cd erplorer-runner &amp;&amp; npm start</code> to enable real browser execution.</div>';
      return;
    }

    const UI_ACTIONS = ['goto','fill','click','expectText','expectVisible','expectUrl','wait'];
    const API_ACTIONS = ['apiRequest','expectStatus','expectJson','expectHeader'];
    const uiSteps = [];
    const apiRows = [];

    for (const row of currentRows) {
      const action = (row.action || '').trim();
      if (UI_ACTIONS.includes(action)) {
        uiSteps.push({
          action: action,
          selector: row.selector || '',
          value: row.value || '',
          url: row.url || '',
          expected: row.expected || ''
        });
      } else if (API_ACTIONS.includes(action)) {
        apiRows.push(row);
      }
    }

    if (!uiSteps.length && !apiRows.length) {
      if (status) status.innerHTML =
        '<div class="status-line warn">No UI or API steps found. Supported: ' +
        UI_ACTIONS.concat(API_ACTIONS).join(', ') + '</div>';
      return;
    }

    if (status) status.innerHTML = '<div class="status-line"><span class="spinner"></span>Starting session…</div>';

    const session = await window.ERplorerRunner.startSession({
      title: 'Lab run · ' + new Date().toLocaleString(),
      userStory: null
    });
    if (!session.ok) {
      if (status) status.innerHTML = '<div class="status-line err">Session start failed: ' + escapeHtml(session.reason) + '</div>';
      return;
    }

    let uiResult = null;
    let apiResult = null;

    if (uiSteps.length) {
      if (status) status.innerHTML = '<div class="status-line"><span class="spinner"></span>Running ' + uiSteps.length + ' UI step' + (uiSteps.length === 1 ? '' : 's') + ' via Playwright…</div>';
      uiResult = await window.ERplorerRunner.runUiSteps(uiSteps, { headless: false });
    }

    if (apiRows.length) {
      if (status) status.innerHTML = '<div class="status-line"><span class="spinner"></span>Running ' + apiRows.length + ' API step' + (apiRows.length === 1 ? '' : 's') + '…</div>';
      const collection = { requests: groupApiSteps(apiRows), stopOnError: false };
      apiResult = await window.ERplorerRunner.runApiCollection(collection, {});
    }

    await window.ERplorerRunner.finishSession();

    if (status) {
      const allOk = (!uiResult || !uiResult.errorCount) && (!apiResult || !apiResult.failCount);
      status.innerHTML =
        '<div class="status-line ' + (allOk ? 'ok' : 'err') + '">' +
          (allOk ? '✅ Run complete' : '❌ Run complete with failures') +
          ' · Session <code>' + session.sessionId.slice(0, 8) + '</code>' +
        '</div>';
    }

    renderRunResults({ ui: uiResult, api: apiResult, sessionId: session.sessionId });
  }

  function groupApiSteps(rows) {
    const requests = [];
    let current = null;
    for (const row of rows) {
      const action = (row.action || '').trim();
      if (action === 'apiRequest') {
        current = {
          name: row.scenario || 'Request',
          method: (row.method || 'GET').toUpperCase(),
          url: row.url || '',
          headers: safeJsonParse(row.headers),
          body: safeJsonParse(row.body),
          expectStatus: null,
          expectJson: {}
        };
        requests.push(current);
      } else if (current) {
        if (action === 'expectStatus') current.expectStatus = Number(row.expected) || null;
        else if (action === 'expectJson' && row.jsonpath) current.expectJson[row.jsonpath] = row.expected;
      }
    }
    return requests;
  }

  function safeJsonParse(str) {
    if (!str) return undefined;
    if (typeof str === 'object') return str;
    try { return JSON.parse(str); } catch (e) { return undefined; }
  }

  function renderRunResults(result) {
    const el = document.getElementById('ai-run-output');
    if (!el) return;

    const runnerUrl = ((CONFIG.runner && CONFIG.runner.baseUrl) || 'http://localhost:8787').replace(/\/$/, '');
    const videoUrl = runnerUrl + '/session/' + result.sessionId + '/video';
    const flowUrl = runnerUrl + '/session/' + result.sessionId + '/flow.md';

    const ui = result.ui;
    const api = result.api;
    const uiOk = !ui || !ui.errorCount;
    const apiOk = !api || !api.failCount;
    const overallOk = uiOk && apiOk;

    let html = '';
    html += '<div class="insights-card" style="margin-top:24px;">';
    html += '<div class="card-title">Run results</div>';
    html += '<div class="env-verdict ' + (overallOk ? 'ok' : 'err') + '" style="margin-top:12px;">';
    html += '<span class="env-dot"></span><strong>' + (overallOk ? 'PASS' : 'FAIL') + '</strong>';
    html += '</div>';

    html += '<div class="run-stats">';
    if (ui) {
      html += '<div class="run-stat"><div class="num">' + (ui.stepCount || 0) + '</div><div class="lbl">UI steps</div></div>';
      html += '<div class="run-stat ' + (ui.errorCount > 0 ? 'bad' : 'good') + '"><div class="num">' + (ui.errorCount || 0) + '</div><div class="lbl">UI errors</div></div>';
    }
    if (api) {
      html += '<div class="run-stat good"><div class="num">' + (api.passCount || 0) + '</div><div class="lbl">API pass</div></div>';
      html += '<div class="run-stat ' + (api.failCount > 0 ? 'bad' : 'good') + '"><div class="num">' + (api.failCount || 0) + '</div><div class="lbl">API fail</div></div>';
    }
    html += '</div>';

    html += '<div style="margin-top:16px;">';
    html += '<div class="card-desc" style="margin-bottom:8px;">Session recording (WebM)</div>';
    html += '<video class="run-video" controls preload="metadata" src="' + videoUrl + '"></video>';
    html += '</div>';

    html += '<div class="row" style="margin-top:16px; gap:8px;">';
    html += '<a class="btn secondary" href="' + videoUrl + '" download>⬇ Download video</a>';
    html += '<a class="btn secondary" href="' + flowUrl + '" target="_blank">📄 Open flow.md</a>';
    html += '<button class="btn secondary" onclick="ERplorer.promoteCurrentSession()">📌 Promote session</button>';
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function promoteCurrentSession() {
    if (!window.ERplorerRunner) return;
    const r = await window.ERplorerRunner.promoteSession();
    if (r.ok) toast('📌 Session promoted — kept beyond 72h');
    else toast('Promote failed: ' + (r.reason || 'unknown'));
  }

  // ============================================================
  // LAB — specs
  // ============================================================
  const ACTIONS = {
    UI:   ['goto','fill','click','expectText','expectVisible','expectUrl','wait'],
    API:  ['apiRequest','expectStatus','expectJson','expectHeader'],
    DATA: ['runSql','expectRowCount','expectNoNulls','expectUnique','expectValue']
  };
  const ALL_ACTIONS = ACTIONS.UI.concat(ACTIONS.API, ACTIONS.DATA);
  const kindOf = a => ACTIONS.UI.includes(a) ? 'ui' : ACTIONS.API.includes(a) ? 'api' : ACTIONS.DATA.includes(a) ? 'data' : 'ui';

  function initLab() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
      dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('over');
        if (e.dataTransfer.files[0]) handleSpecFile(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener('change', e => {
        if (e.target.files[0]) handleSpecFile(e.target.files[0]);
      });
    }
  }

  function handleSpecFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();
    const genOut = document.getElementById('gen-output');
    reader.onload = e => {
      try {
        let wb;
        if (['csv','tsv','txt'].includes(ext)) wb = XLSX.read(e.target.result, { type: 'string', raw: false });
        else wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        if (!rows.length) { if (genOut) genOut.innerHTML = '<div class="status-line err">No rows found.</div>'; return; }
        renderSpecs(rows, file.name);
      } catch (err) {
        if (genOut) genOut.innerHTML = '<div class="status-line err">Failed: ' + escapeHtml(err.message) + '</div>';
      }
    };
    if (['csv','tsv','txt'].includes(ext)) reader.readAsText(file, 'utf-8');
    else reader.readAsArrayBuffer(file);
  }

  function renderSpecs(rows, filename) {
    const genOut = document.getElementById('gen-output');
    if (!genOut) return;
    const cases = {};
    const errors = [];
    rows.forEach((row, i) => {
      if (!row.id) return;
      Object.keys(row).forEach(k => row[k] = String(row[k] == null ? '' : row[k]).trim());
      if (!row.action) { errors.push('Row ' + (i+2) + ': missing action'); return; }
      if (!ALL_ACTIONS.includes(row.action)) { errors.push('Row ' + (i+2) + ': unknown action "' + row.action + '"'); return; }
      if (!cases[row.id]) cases[row.id] = { id: row.id, scenario: row.scenario || row.id, steps: [] };
      cases[row.id].steps.push(row);
    });

    if (errors.length) {
      genOut.innerHTML = '<div class="status-line err">' + errors.map(escapeHtml).join('<br>') + '</div>';
      return;
    }

    const specs = [];
    for (const tc of Object.values(cases)) {
      const pw = tc.steps.filter(s => ['ui','api'].includes(kindOf(s.action)));
      const data = tc.steps.filter(s => kindOf(s.action) === 'data');
      if (pw.length) specs.push({
        name: tc.id + '.spec.js',
        code: buildPlaywright(tc, pw, filename),
        label: 'Playwright · ' + (pw.every(s => kindOf(s.action) === 'api') ? 'api' : 'ui')
      });
      if (data.length) specs.push({
        name: tc.id + '_test.py',
        code: buildPytest(tc, data, filename),
        label: 'pytest + PySpark · data'
      });
    }

    if (!specs.length) { genOut.innerHTML = '<div class="status-line warn">No test cases found.</div>'; return; }

    genOut.innerHTML = '' +
      '<div class="hero-eyebrow" style="margin-top:24px;">Generated ' + specs.length + ' file' + (specs.length === 1 ? '' : 's') + '</div>' +
      specs.map((s, i) =>
        '<div class="card">' +
          '<div class="card-title" style="font-family:ui-monospace,monospace; font-size:14px;">' + escapeHtml(s.name) + '</div>' +
          '<div class="card-desc">' + escapeHtml(s.label) + '</div>' +
          '<div class="row" style="margin-top:12px;">' +
            '<button class="btn secondary" onclick="ERplorer.previewSpec(' + i + ')">Preview</button>' +
            '<button class="btn" onclick="ERplorer.downloadSpec(' + i + ')">Download</button>' +
          '</div>' +
        '</div>'
      ).join('') +
      '<div class="row" style="margin-top:14px; gap:8px;">' +
        '<button class="btn accent" onclick="ERplorer.runScenariosViaRunner()" style="flex:1;">▶ Run all via runner</button>' +
      '</div>' +
      '<div id="spec-preview"></div>' +
      '<div id="ai-run-output"></div>';

    window._specs = specs;
  }

  function previewSpec(i) {
    const el = document.getElementById('spec-preview');
    if (!el) return;
    el.innerHTML = '<div class="hero-eyebrow" style="margin-top:24px;">Preview</div><div class="preview-block">' + escapeHtml(window._specs[i].code) + '</div>';
  }

  function downloadSpec(i) {
    const s = window._specs[i];
    downloadFile(s.name, s.code, s.name.endsWith('.py') ? 'text/x-python' : 'text/javascript');
  }

  function buildPlaywright(tc, steps, source) {
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const lines = steps.map(s => {
      const action = s.action;
      const method = s.method || '';
      const url = s.url || '';
      const headers = s.headers || '';
      const body = s.body || '';
      const selector = s.selector || '';
      const value = s.value || '';
      const expected = s.expected || '';
      const jsonpath = s.jsonpath || '';
      switch (action) {
        case 'goto':          return '  await page.goto(\'' + esc(url || value) + '\');';
        case 'fill':          return '  await page.fill(\'' + esc(selector) + '\', \'' + esc(value) + '\');';
        case 'click':         return '  await page.click(\'' + esc(selector) + '\');';
        case 'expectText':    return '  await expect(page.locator(\'' + esc(selector) + '\')).toContainText(\'' + esc(expected || value) + '\');';
        case 'expectVisible': return '  await expect(page.locator(\'' + esc(selector) + '\')).toBeVisible();';
        case 'expectUrl':     return '  await expect(page).toHaveURL(/' + esc(url || value) + '/);';
        case 'wait':          return '  await page.waitForTimeout(' + (Number(value) || 1000) + ');';
        case 'apiRequest': {
          const m = (method || 'GET').toUpperCase();
          const opts = [];
          if (headers) opts.push('headers: ' + headers);
          if (body) opts.push('data: ' + body);
          return '  const response = await request.' + m.toLowerCase() + '(\'' + esc(url) + '\'' + (opts.length ? ', { ' + opts.join(', ') + ' }' : '') + ');';
        }
        case 'expectStatus':  return '  expect(response.status()).toBe(' + (Number(expected) || 200) + ');';
        case 'expectJson':    return '  expect((await response.json())' + (jsonpath || '').replace(/^[A-Za-z_$][\w$]*/, '').replace(/\[(\d+)\]/g, '[$1]') + ').toBe(\'' + esc(expected) + '\');';
        case 'expectHeader':  return '  expect(response.headers()[\'' + esc(selector.toLowerCase()) + '\']).toBe(\'' + esc(expected) + '\');';
        default:              return '  // unsupported: ' + esc(action);
      }
    }).join('\n');

    return '// AUTO-GENERATED from ' + source + '\nconst { test, expect } = require(\'@playwright/test\');\n\ntest(\'' + esc(tc.id) + ': ' + esc(tc.scenario) + '\', async ({ page, request }) => {\n' + lines + '\n});\n';
  }

  function buildPytest(tc, steps, source) {
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    const setup = [];
    const tests = [];
    let qv = null;
    let qn = 0;
    for (const s of steps) {
      const action = s.action;
      const selector = s.selector || '';
      const value = s.value || '';
      const expected = s.expected || '';
      if (action === 'runSql') { qn++; qv = 'result_' + qn; setup.push(qv + ' = spark.sql("""' + esc(value) + '""").collect()'); }
      else if (action === 'expectRowCount') tests.push('    assert len(' + qv + ') == ' + (Number(expected) || 0));
      else if (action === 'expectNoNulls') tests.push('    nulls = spark.sql("SELECT COUNT(*) FROM ' + esc(selector) + ' WHERE ' + esc(selector) + ' IS NULL").collect()[0][0]\n    assert nulls == 0, f"Found {nulls} NULLs in ' + esc(selector) + '"');
      else if (action === 'expectUnique') tests.push('    dupes = spark.sql("SELECT ' + esc(selector) + ' FROM ' + esc(selector) + ' GROUP BY ' + esc(selector) + ' HAVING COUNT(*) > 1").collect()\n    assert len(dupes) == 0');
      else if (action === 'expectValue') tests.push('    assert str(' + qv + '[0][0]).strip() == \'' + esc(expected) + '\'');
    }

    return '# AUTO-GENERATED from ' + source + '\nimport pytest\nfrom pyspark.sql import SparkSession\n\n\n@pytest.fixture(scope="session")\ndef spark():\n    return SparkSession.builder.appName("erplorer").getOrCreate()\n\n\ndef test_' + slug(tc.id + '_' + tc.scenario) + '(spark):\n    """' + esc(tc.scenario) + '"""\n' + setup.map(l => '    ' + l).join('\n') + '\n' + (tests.join('\n') || '    pass') + '\n';
  }

  // ============================================================
  // TEMPLATES
  // ============================================================
  const TEMPLATE_ROWS = [
    ['id','scenario','step','action','method','url','headers','body','selector','value','expected','jsonpath'],
    ['TC001','Login UI flow','1','goto','','/login','','','','','',''],
    ['TC001','Login UI flow','2','fill','','','','','#username','admin','',''],
    ['TC001','Login UI flow','3','fill','','','','','#password','secret123','',''],
    ['TC001','Login UI flow','4','click','','','','','button[type=submit]','','',''],
    ['TC001','Login UI flow','5','expectText','','','','','.dashboard','','Welcome admin',''],
    ['TC002','Users API returns alice','1','apiRequest','GET','/api/users','{"Accept":"application/json"}','','','','',''],
    ['TC002','Users API returns alice','2','expectStatus','','','','','','','200',''],
    ['TC002','Users API returns alice','3','expectJson','','','','','','','alice','data[0].name'],
    ['TC003','Users table has no nulls','1','runSql','','','','','','SELECT COUNT(*) FROM users','',''],
    ['TC003','Users table has no nulls','2','expectRowCount','','','','','','','1',''],
    ['TC003','Users table has no nulls','3','expectNoNulls','','','','','users','','','']
  ];

  function downloadTemplate(format) {
    const isTsv = format === 'tsv';
    const csvEsc = v => {
      const s = String(v == null ? '' : v);
      return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = TEMPLATE_ROWS.map(r => isTsv ? r.join('\t') : r.map(csvEsc).join(',')).join('\n');
    downloadFile('TEMPLATE.' + (isTsv ? 'tsv' : 'csv'), body, isTsv ? 'text/tab-separated-values' : 'text/csv');
  }

  // ============================================================
  // INGEST
  // ============================================================
  const BUILTIN_PATTERNS = [
    { type: 'error',        re: /(?:throw new Error|Error\(|console\.error)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g },
    { type: 'java-error',   re: /throw new \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g },
    { type: 'java-error',   re: /LOG(?:GER)?\.(?:error|warn|severe)\s*\(\s*(?:[^,)]+,\s*)?"([^"]+)"/gi },
    { type: 'python-error', re: /raise \w+(?:Error|Exception)\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g },
    { type: 'python-error', re: /dbutils\.notebook\.exit\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g },
    { type: 'sql-error',    re: /RAISE\s+EXCEPTION\s+'([^']+)'/gi },
    { type: 'sql-error',    re: /\b(INVALID_FORMAT|PATH_NULL|MALFORMED_FILE_REF|TABLE_OR_VIEW_NOT_FOUND|PARSE_SYNTAX_ERROR|UNRESOLVED_COLUMN)\b/g },
    { type: 'config-error', re: /^\s*(?:error|failure|reason|message)\s*:\s*["']?([^"'\n#]+)/gim }
  ];

  function getActivePatterns() {
    const merged = BUILTIN_PATTERNS.slice();
    for (const p of customPatterns) {
      if (p.enabled === false) continue;
      try {
        merged.push({
          type: p.type || 'custom-error',
          re: new RegExp(p.pattern, 'g'),
          exts: p.exts ? p.exts.split(',').map(e => e.trim()).filter(Boolean) : null
        });
      } catch (err) { /* skip invalid */ }
    }
    return merged;
  }

  function detectType(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['java','kt','groovy','scala'].includes(ext)) return 'java-error';
    if (ext === 'py') return 'python-error';
    if (ext === 'sql') return 'sql-error';
    if (['yaml','yml','properties','env','json'].includes(ext)) return 'config-error';
    return 'code';
  }

  function parseText(text, name) {
    const entries = [];
    const lines = text.split('\n');
    const defType = detectType(name);
    const fileExt = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
    for (const pattern of getActivePatterns()) {
      if (pattern.exts && pattern.exts.length && !pattern.exts.includes(fileExt)) continue;
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(text)) !== null) {
        let msg = null;
        for (let i = 1; i < m.length; i++) if (m[i]) { msg = m[i]; break; }
        if (!msg || msg.trim().length < 3) continue;
        const lineNum = text.substring(0, m.index).split('\n').length;
        const start = Math.max(0, lineNum - 3);
        const end = Math.min(lines.length, lineNum + 2);
        entries.push({
          type: pattern.type || defType,
          text: msg.trim(),
          file: name,
          line: lineNum,
          context: lines.slice(start, end).join('\n')
        });
      }
    }
    return entries;
  }

  function appendToIndex(entries, label) {
    if (!entries.length) { showAddStatus('warn', 'No errors found in ' + label + '.'); return 0; }
    const base = documents.length;
    entries.forEach((e, i) => {
      documents.push(e);
      if (flexIndex) flexIndex.add(Object.assign({}, e, { id: base + i }));
    });
    ingestCount += entries.length;
    const cnt = document.getElementById('ingest-count');
    if (cnt) cnt.textContent = ingestCount;
    renderStats();
    renderChips();
    showAddStatus('ok', 'Added ' + entries.length + ' entries from ' + label + '. Total: ' + documents.length + '.');
    dispatchWebhook('index.updated', { added: entries.length, source: label, total: documents.length });

    // Refresh Insights with the newly captured file contents
    if (window.ERplorerInsights && typeof window.ERplorerInsights.refresh === 'function') {
      try { window.ERplorerInsights.refresh(); } catch (e) { /* ignore */ }
    }

    return entries.length;
  }

  function showAddStatus(kind, html) {
    const el = document.getElementById('add-status');
    if (!el) return;
    el.style.display = 'block';
    el.className = 'status-line ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err');
    el.innerHTML = html;
  }

  function setAddLoading(html) {
    const el = document.getElementById('add-status');
    if (!el) return;
    el.style.display = 'block';
    el.className = 'status-line';
    el.innerHTML = '<span class="spinner"></span>' + html;
  }

  async function tryTier1Crawl() {
    const input = document.getElementById('crawl-url');
    if (!input) return;
    const url = input.value.trim();
    if (!/^https?:\/\//.test(url)) { showAddStatus('err', 'URL must start with http:// or https://'); return; }
    setAddLoading('Fetching ' + url + '…');
    try {
      const res = await fetchWithTimeout(CONFIG.endpoints.crawl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, maxPages: 20 })
      }, 30000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const pages = data.pages || data.results || (Array.isArray(data) ? data : []);
      if (!pages.length) throw new Error('Crawl returned 0 pages');
      const entries = [];
      for (const p of pages) entries.push(...parseText(p.text || p.content || '', p.url || p.title || url));
      if (!entries.length) throw new Error('No errors found in crawled pages');
      appendToIndex(entries, pages.length + ' crawled pages');
    } catch (err) {
      showAddStatus('err', 'Crawl failed: ' + escapeHtml(err.message) + '. Try scan, drop, or paste instead.');
    }
  }

  async function tryTier2Repo() {
    const input = document.getElementById('repo-scan');
    if (!input) return;
    const spec = parseRepoSpec(input.value);
    if (!spec) {
      showAddStatus('err', 'Format: owner/repo, or owner/repo#branch, or a github.com URL.');
      return;
    }
    const owner = spec.owner;
    const repo = spec.repo;
    const token = sessionStorage.getItem('gh_token') || null;

    const controller = new AbortController();
    _repoScanController = controller;

    setAddLoading('Looking up ' + owner + '/' + repo + '…');
    const t0 = performance.now();

    try {
      const branch = spec.branch || await detectDefaultBranch(owner, repo, token, controller.signal);
      const branchSource = spec.branch ? 'specified' : 'auto-detected';

      setAddLoading(owner + '/' + repo + '@' + branch + ' · listing files…');
      const allFiles = await listRepoFiles(owner, repo, branch, token, controller.signal);

      const files = allFiles
        .filter(f => /\.(js|ts|jsx|tsx|java|kt|groovy|scala|py|sql|yaml|yml|json|properties|env|ipynb)$/i.test(f.path))
        .slice(0, 300);

      if (!files.length) {
        showAddStatus('warn', 'No indexable files found in ' + owner + '/' + repo + '@' + branch + '.');
        return;
      }

      const fileContents = await parallelMap(
        files,
        8,
        async f => {
          const content = await fetchRawFile(owner, repo, branch, f.path, controller.signal);
          if (content) {
            window._erplorerFileContents.set(f.path, content);
            return { path: f.path, content: content };
          }
          return null;
        },
        (done, total) => {
          const pct = Math.round((done / total) * 100);
          const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          const eta = done > 0 ? (((performance.now() - t0) / done) * (total - done) / 1000).toFixed(0) : '?';
          setAddLoading(owner + '/' + repo + '@' + branch + ' · ' + done + '/' + total + ' (' + pct + '%) · ' + elapsed + 's elapsed · ~' + eta + 's left');
        }
      );

      setAddLoading(owner + '/' + repo + '@' + branch + ' · parsing ' + fileContents.filter(Boolean).length + ' files…');
      const entries = [];
      let fetched = 0;
      for (const fc of fileContents) {
        if (!fc) continue;
        fetched++;
        entries.push(...parseText(fc.content, fc.path));
      }

      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

      if (!entries.length) {
        showAddStatus('warn', 'Fetched ' + fetched + '/' + files.length + ' files from ' + owner + '/' + repo + '@' + branch + ' in ' + elapsed + 's but no errors matched.');
        return;
      }

      appendToIndex(entries, owner + '/' + repo + '@' + branch + ' (' + fetched + ' files · ' + branchSource + ' · ' + elapsed + 's)');
    } catch (err) {
      if (err.name === 'AbortError') {
        showAddStatus('warn', 'Scan cancelled.');
        return;
      }
      showAddStatus('err', 'Scan failed: ' + escapeHtml(err.message) + '. Private repos need a token in Settings.');
    } finally {
      _repoScanController = null;
    }
  }

  function cancelRepoScan() {
    if (_repoScanController) _repoScanController.abort();
  }

  async function tryQuickFileUrl() {
    const input = document.getElementById('quick-file-url');
    if (!input) return;
    const url = input.value.trim();
    if (!url) { showAddStatus('err', 'Paste a file URL first.'); return; }

    const parsed = parseGithubUrlToRaw(url);
    if (!parsed) {
      showAddStatus('err', 'Not a recognized GitHub file URL. Use a raw.githubusercontent.com link or a github.com/…/blob/… link.');
      return;
    }

    setAddLoading('Fetching ' + parsed.filePath + '…');
    try {
      const res = await fetchWithTimeout(parsed.rawUrl, {}, 15000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const content = await res.text();
      window._erplorerFileContents.set(parsed.filePath, content);
      const entries = parseText(content, parsed.filePath);
      if (!entries.length) {
        appendToIndex([{
          type: 'code',
          text: content.slice(0, 120),
          file: parsed.filePath,
          line: 1,
          context: content.slice(0, 800)
        }], parsed.filePath);
      } else {
        appendToIndex(entries, parsed.filePath);
      }
      input.value = '';
    } catch (err) {
      showAddStatus('err', 'Fetch failed: ' + escapeHtml(err.message) + '. Check the URL and that the file/branch exists.');
    }
  }

  function initTier3File() {
    const inp = document.getElementById('tier3-file');
    if (!inp) return;
    inp.addEventListener('change', async e => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      setAddLoading('Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…');
      const entries = [];
      for (const f of files) {
        try {
          const text = await f.text();
          window._erplorerFileContents.set(f.name, text);
          entries.push(...parseText(text, f.name));
        } catch (err) { /* skip */ }
      }
      if (!entries.length) { showAddStatus('warn', 'No errors found.'); return; }
      appendToIndex(entries, files.length + ' files');
      e.target.value = '';
    });
  }

  function tryTier4Paste() {
    const el = document.getElementById('tier4-text');
    if (!el) return;
    const text = el.value;
    if (!text.trim()) { showAddStatus('warn', 'Nothing to add.'); return; }
    const entries = parseText(text, 'pasted-content');
    if (!entries.length) {
      appendToIndex([{
        type: 'code',
        text: text.slice(0, 120),
        file: 'pasted-content',
        line: 1,
        context: text.slice(0, 800)
      }], 'pasted text');
    } else {
      appendToIndex(entries, 'pasted text');
    }
    el.value = '';
  }

  // ============================================================
  // OCR
  // ============================================================
  async function loadTesseract() {
    if (tesseractMod) return tesseractMod;
    tesseractMod = await import(CONFIG.cdn.tesseract);
    return tesseractMod;
  }

  async function ocrImage(file) {
    const status = document.getElementById('ocr-status');
    const preview = document.getElementById('ocr-preview');
    if (!status) return;
    status.style.display = 'block';
    status.className = 'status-line';
    status.innerHTML = '<span class="spinner"></span>Loading OCR engine (first time only)…';

    try {
      const mod = await loadTesseract();
      const Tesseract = mod.default || mod;
      status.innerHTML = '<span class="spinner"></span>Reading text from image…';
      const result = await Tesseract.recognize(file, 'eng');
      const text = (result.data && result.data.text) ? result.data.text.trim() : '';
      if (!text) { status.className = 'status-line warn'; status.textContent = 'No text detected in the image.'; return; }
      status.className = 'status-line ok';
      status.innerHTML = '✅ Extracted ' + text.length + ' characters.';

      if (preview) {
        preview.innerHTML = '' +
          '<div class="card">' +
            '<div class="card-title" style="font-size:14px;">Extracted text</div>' +
            '<textarea class="textarea" id="ocr-text" style="min-height:120px; font-family:ui-monospace,monospace; font-size:12px;">' + escapeHtml(text) + '</textarea>' +
            '<div class="row" style="margin-top:10px;">' +
              '<button class="btn" onclick="ERplorer.indexOCRText()">Add to index</button>' +
              '<button class="btn secondary" onclick="ERplorer.copyOCRText()">Copy</button>' +
            '</div>' +
          '</div>';
      }
    } catch (err) {
      status.className = 'status-line err';
      status.textContent = 'OCR failed: ' + err.message;
    }
  }

  function indexOCRText() {
    const ta = document.getElementById('ocr-text');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    const entries = parseText(text, 'screenshot-ocr');
    if (!entries.length) {
      appendToIndex([{ type: 'code', text: text.slice(0, 120), file: 'screenshot-ocr', line: 1, context: text.slice(0, 800) }], 'screenshot');
    } else {
      appendToIndex(entries, 'screenshot');
    }
    const preview = document.getElementById('ocr-preview');
    if (preview) preview.innerHTML = '';
    const status = document.getElementById('ocr-status');
    if (status) status.style.display = 'none';
  }

  async function copyOCRText() {
    const ta = document.getElementById('ocr-text');
    if (!ta) return;
    const ok = await copyToClipboard(ta.value);
    toast(ok ? '📋 Copied' : '⚠️ Copy failed');
  }

  function initOCR() {
    const drop = document.getElementById('ocr-drop');
    const inp = document.getElementById('ocr-file');
    if (!drop || !inp) return;
    drop.addEventListener('click', () => inp.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer.files[0]) ocrImage(e.dataTransfer.files[0]);
    });
    inp.addEventListener('change', e => {
      if (e.target.files[0]) ocrImage(e.target.files[0]);
    });
    window.addEventListener('paste', e => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { ocrImage(f); break; }
        }
      }
    });
  }

  // ============================================================
  // PATTERNS
  // ============================================================
  async function loadCustomPatterns() {
    try { customPatterns = await dbGetAll('patterns'); }
    catch (err) { customPatterns = []; }
  }

  // ============================================================
  // PDF REPORT
  // ============================================================
  async function loadJsPDF() {
    if (jsPdfMod) return jsPdfMod;
    const mod = await import(CONFIG.cdn.jspdf);
    jsPdfMod = mod.jsPDF || mod.default;
    return jsPdfMod;
  }

  async function generatePDFReport() {
    if (!Object.keys(currentResults).length) { toast('No results to export'); return; }
    toast('Generating PDF…');
    try {
      const jsPDF = await loadJsPDF();
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const margin = 40;
      const pw = doc.internal.pageSize.width;
      const ph = doc.internal.pageSize.height;
      const cw = pw - margin * 2;
      let y = 60;

      doc.setFontSize(22); doc.setFont(undefined, 'bold');
      doc.text('ERplorer Report', margin, y); y += 30;
      doc.setFontSize(11); doc.setFont(undefined, 'normal'); doc.setTextColor(120);
      doc.text('Generated ' + new Date().toLocaleString(), margin, y); y += 16;
      const si = document.getElementById('search-input');
      if (si && si.value.trim()) doc.text('Query: ' + si.value.trim(), margin, y); y += 16;
      doc.text('Results: ' + Object.keys(currentResults).length, margin, y); y += 24;
      doc.setTextColor(0);

      const results = Object.values(currentResults);
      for (const d of results) {
        if (y > ph - 120) { doc.addPage(); y = 60; }
        doc.setFontSize(11); doc.setFont(undefined, 'bold');
        doc.text((d.file || 'unknown') + (d.line ? ':' + d.line : ''), margin, y); y += 14;
        doc.setFontSize(10); doc.setFont(undefined, 'normal');
        const msg = doc.splitTextToSize(d.text || '', cw);
        for (const line of msg) {
          if (y > ph - 60) { doc.addPage(); y = 60; }
          doc.text(line, margin, y); y += 13;
        }
        if (d.context) {
          if (y > ph - 100) { doc.addPage(); y = 60; }
          doc.setFontSize(8); doc.setTextColor(100);
          const ctx = doc.splitTextToSize(d.context, cw);
          for (const line of ctx.slice(0, 12)) {
            if (y > ph - 60) { doc.addPage(); y = 60; }
            doc.text(line, margin + 10, y); y += 10;
          }
          doc.setTextColor(0);
          y += 6;
        }
        const recipe = getFixRecipe(d.text || '');
        if (recipe) {
          if (y > ph - 80) { doc.addPage(); y = 60; }
          doc.setFontSize(9); doc.setTextColor(178, 106, 52);
          doc.text('Fix recipe:', margin, y); y += 12;
          doc.setTextColor(60);
          const rec = doc.splitTextToSize(recipe.suggestion, cw - 10);
          for (const line of rec) {
            if (y > ph - 60) { doc.addPage(); y = 60; }
            doc.text(line, margin + 10, y); y += 11;
          }
          doc.setTextColor(0);
        }
        y += 10;
      }
      doc.save('erplorer-report-' + Date.now() + '.pdf');
      toast('📄 PDF downloaded');
    } catch (err) {
      toast('⚠️ PDF failed: ' + err.message);
      console.error(err);
    }
  }

  // ============================================================
  // SCREENSHOT
  // ============================================================
  async function loadHtml2Canvas() {
    if (html2canvasMod) return html2canvasMod;
    const mod = await import(CONFIG.cdn.html2canvas);
    html2canvasMod = mod.default || mod;
    return html2canvasMod;
  }

  async function captureSearchScreenshot() {
    const target = document.getElementById('results');
    if (!target) return;
    toast('Capturing screenshot…');
    try {
      const html2canvas = await loadHtml2Canvas();
      const canvas = await html2canvas(target, { backgroundColor: null, scale: 2 });
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'erplorer-results-' + Date.now() + '.png';
      a.click();
      toast('📷 Screenshot saved');
    } catch (err) {
      toast('⚠️ Screenshot failed: ' + err.message);
      console.error(err);
    }
  }

  // ============================================================
  // SETTINGS
  // ============================================================
  function saveToken() {
    const inp = document.getElementById('token-input');
    if (!inp) return;
    const t = inp.value.trim();
    if (t) {
      sessionStorage.setItem('gh_token', t);
      const st = document.getElementById('token-status');
      if (st) st.textContent = 'Token saved to session.';
    }
  }

  function clearToken() {
    sessionStorage.removeItem('gh_token');
    const inp = document.getElementById('token-input');
    if (inp) inp.value = '';
    const st = document.getElementById('token-status');
    if (st) st.textContent = 'Token cleared.';
  }

  async function resetAllLocalData() {
    if (!confirm('Delete all search history and custom patterns?')) return;
    try {
      await dbClear('searches');
      await dbClear('patterns');
      customPatterns = [];
      renderHistory();
    } catch (err) { /* ignore */ }
  }

  function renderConfigDisplay() {
    const el = document.getElementById('config-display');
    if (!el) return;
    const summary = {
      version: CONFIG.version,
      endpoints: CONFIG.endpoints,
      features: CONFIG.features,
      runner: CONFIG.runner,
      webhooks: Object.keys(CONFIG.webhooks || {}).reduce((a, k) => {
        const h = CONFIG.webhooks[k];
        a[k] = h && h.enabled ? 'enabled' : 'disabled';
        return a;
      }, {}),
      mcp: CONFIG.mcp
    };
    el.textContent = JSON.stringify(summary, null, 2);
  }

  // ============================================================
  // BOOT
  // ============================================================
  async function boot() {
    initTheme();
    initNav();
    initSearch();
    initLab();
    initTier3File();
    initOCR();

    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const lb = document.getElementById('theme-light-btn');
    const db = document.getElementById('theme-dark-btn');
    if (lb) lb.classList.toggle('active', theme === 'light');
    if (db) db.classList.toggle('active', theme === 'dark');

    const usp = document.getElementById('usp-banner');
    if (usp && !CONFIG.ui.showUSPBanner) usp.style.display = 'none';

    const existing = sessionStorage.getItem('gh_token');
    if (existing) {
      const inp = document.getElementById('token-input');
      const st = document.getElementById('token-status');
      if (inp) inp.value = existing;
      if (st) st.textContent = 'Token loaded from session.';
    }

    await loadCustomPatterns();
    await renderHistory();
    await loadIndex();
    renderConfigDisplay();

    try {
      const r = await fetchWithTimeout(CONFIG.endpoints.aiPrimary, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'ping', context: '' })
      }, 10000);
      const el = document.getElementById('api-status');
      if (el) {
        if (r.ok) { el.className = 'status-line ok'; el.textContent = 'AI endpoint reachable.'; }
        else { el.className = 'status-line warn'; el.textContent = 'Primary responded ' + r.status + '. Fallback available.'; }
      }
    } catch (err) {
      const el = document.getElementById('api-status');
      if (el) {
        el.className = 'status-line warn';
        el.textContent = 'Primary AI unreachable. Fallback: Pollinations, then rules.';
      }
    }

    checkMCP();
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  window.ERplorer = {
    // Theme
    setTheme: setTheme,
    toggleTheme: toggleTheme,

    // Search
    runSearch: runSearch,
    setFilter: setFilter,
    rerunSearch: rerunSearch,
    clearHistory: clearHistory,

    // Ask
    askNatural: askNatural,
    quickAsk: quickAsk,

    // Lab
    loadSampleScenarios: loadSampleScenarios,
    runAITransform: runAITransform,
    runRuleTransform: runRuleTransform,
    downloadRows: downloadRows,
    generateFromRows: generateFromRows,
    getCurrentRows: getCurrentRows,
    runScenariosViaRunner: runScenariosViaRunner,
    promoteCurrentSession: promoteCurrentSession,
    previewSpec: previewSpec,
    downloadSpec: downloadSpec,
    downloadTemplate: downloadTemplate,

    // Ingest
    tryTier1Crawl: tryTier1Crawl,
    tryTier2Repo: tryTier2Repo,
    tryTier4Paste: tryTier4Paste,
    tryQuickFileUrl: tryQuickFileUrl,
    cancelRepoScan: cancelRepoScan,

    // OCR
    indexOCRText: indexOCRText,
    copyOCRText: copyOCRText,

    // Result actions
    copyBugReport: copyBugReport,
    copyShareLink: copyShareLink,
    copyFilePath: copyFilePath,
    copyAllResults: copyAllResults,

    // Reports
    generatePDFReport: generatePDFReport,
    captureSearchScreenshot: captureSearchScreenshot,

    // Settings
    saveToken: saveToken,
    clearToken: clearToken,
    resetAllLocalData: resetAllLocalData,

    // Diagnostics
    config: CONFIG,
    state: function () {
      return {
        documents: documents.length,
        customPatterns: customPatterns.length,
        activeFilter: activeFilter,
        currentRows: currentRows.length,
        fileContents: window._erplorerFileContents.size
      };
    },
    version: CONFIG.version
  };

  // Boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();