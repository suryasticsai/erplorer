/**
 * ERplorer Quick Fix — propose a fix and open a draft PR.
 *
 * Adds a 🔧 Propose fix button to result cards whose error matches
 * a deterministic, safe fixable pattern. On tap:
 *
 *   1. Fetches the current file from the repo (raw CDN)
 *   2. Applies a curated transformation (null guard, optional chain, etc.)
 *   3. Shows a diff preview before anything happens
 *   4. On confirm, opens a DRAFT PR via Octokit
 *
 * Safety rails:
 *   - Only ~8 curated patterns get the button. Random errors don't.
 *   - Diffs are always shown before a PR opens.
 *   - PRs open as drafts — never ready-to-merge.
 *   - Requires a saved GitHub token with `repo` scope + a saved repo.
 *   - Never modifies an existing branch; always creates a new one.
 *
 * Requires in localStorage:
 *   erplorer_gh_repo  → "owner/repo"    (set from Settings)
 * Requires in sessionStorage:
 *   gh_token          → PAT with repo scope
 *
 * Exposes:
 *   window.ERplorerQuickFix.proposeFor(docId)
 *   window.ERplorerQuickFix.state()
 */
(function () {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const CONFIG = (window.ERPLORER_CONFIG && window.ERPLORER_CONFIG.quickfix) || {};
  const RAW_FETCH_TIMEOUT = 15000;
  const OCTOKIT_CDN = 'https://esm.sh/@octokit/rest@21';

  let OctokitClass = null;
  async function ensureOctokit() {
    if (OctokitClass) return OctokitClass;
    const m = await import(OCTOKIT_CDN);
    OctokitClass = m.Octokit || m.default;
    return OctokitClass;
  }

  // ============================================================
  // STATE
  // ============================================================
  const STATE = {
    lastFix: null,
    lastPr: null,
    busy: false
  };

  // ============================================================
  // UTILITIES
  // ============================================================
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, dur) {
    dur = dur || 2600;
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, dur);
  }

  function slug(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  // Safe base64 for unicode content
  function toBase64(str) {
    const bytes = new TextEncoder().encode(String(str));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function fromBase64(b64) {
    const binary = atob(String(b64).replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, Object.assign({}, options, { signal: ctrl.signal }))
      .finally(function () { clearTimeout(timer); });
  }

  // ============================================================
  // FIXABLE PATTERN LIBRARY
  // Each pattern:
  //   - match(text): returns match object or null
  //   - appliesTo(path): optional path filter
  //   - patch(doc, lines, targetIdx): returns { lines, description } or null
  // ============================================================
  const PATTERNS = [
    {
      id: 'null-guard-js',
      label: 'Add null guard',
      appliesTo: p => /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(p),
      match: /cannot read propert(?:y|ies)\s+['"]?(\w+)['"]?\s+of\s+(undefined|null)/i,
      patch: function (doc, lines, targetIdx) {
        const m = doc.text.match(this.match);
        if (!m) return null;
        const prop = m[1];
        // Find parent identifier on the target line
        const targetLine = lines[targetIdx];
        const accessMatch = targetLine.match(new RegExp('([A-Za-z_$][\\w$.]*)\\s*(?:\\?\\.|\\.)\\s*' + prop + '\\b'));
        if (!accessMatch) return null;
        const parts = accessMatch[1].split('.');
        const parent = parts[parts.length - 1];
        if (!parent || parent === 'this') return null;

        const indent = (targetLine.match(/^\s*/) || [''])[0];
        const guardLine = indent + 'if (!' + parent + ') return;';
        const newLines = lines.slice();
        newLines.splice(targetIdx, 0, guardLine);
        return {
          lines: newLines,
          description: 'Inserted a null guard before line ' + (targetIdx + 1) +
            ' protecting access to "' + prop + '" on "' + parent + '".'
        };
      }
    },
    {
      id: 'optional-chain-js',
      label: 'Use optional chaining',
      appliesTo: p => /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(p),
      match: /cannot read propert(?:y|ies)\s+['"]?(\w+)['"]?\s+of\s+(undefined|null)/i,
      patch: function (doc, lines, targetIdx) {
        const m = doc.text.match(this.match);
        if (!m) return null;
        const prop = m[1];
        const targetLine = lines[targetIdx];
        // Replace `parent.prop` with `parent?.prop` — only the first occurrence on the line
        const re = new RegExp('\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*' + prop + '\\b');
        if (!re.test(targetLine)) return null;
        const newLine = targetLine.replace(re, '$1?.' + prop);
        if (newLine === targetLine) return null;
        const newLines = lines.slice();
        newLines[targetIdx] = newLine;
        return {
          lines: newLines,
          description: 'Changed `.` to `?.` for the "' + prop + '" access on line ' + (targetIdx + 1) + '.'
        };
      }
    },
    {
      id: 'empty-catch-js',
      label: 'Log inside empty catch',
      appliesTo: p => /\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(p),
      match: /(?:empty catch|unhandled)/i,
      patch: function (doc, lines, targetIdx) {
        // Find the empty catch block near the target line
        for (let i = Math.max(0, targetIdx - 3); i < Math.min(lines.length, targetIdx + 4); i++) {
          const line = lines[i];
          if (/catch\s*(\([^)]*\))?\s*\{\s*\}\s*;?/.test(line)) {
            const indent = (line.match(/^\s*/) || [''])[0];
            const newLine = line.replace(/catch\s*(\([^)]*\))?\s*\{\s*\}\s*;?/,
              function (full, parens) {
                return 'catch' + (parens || ' (e)') + ' { console.warn("caught:", ' +
                  (parens ? parens.replace(/[()]/g, '').trim().split(/\s+/).pop() : 'e') + '); }';
              });
            const newLines = lines.slice();
            newLines[i] = newLine;
            return {
              lines: newLines,
              description: 'Added a console.warn inside the empty catch on line ' + (i + 1) + '.'
            };
          }
        }
        return null;
      }
    },
    {
      id: 'py-get-key',
      label: 'Use .get() for dict access',
      appliesTo: p => /\.py$/i.test(p),
      match: /KeyError:\s*['"]?(\w+)['"]?/i,
      patch: function (doc, lines, targetIdx) {
        const m = doc.text.match(this.match);
        if (!m) return null;
        const key = m[1];
        const targetLine = lines[targetIdx];
        // Replace dict[key] with dict.get(key)
        const re = new RegExp('([A-Za-z_$][\\w$]*)\\s*\\[\\s*[\'"]' + key + '[\'"]\\s*\\]');
        if (!re.test(targetLine)) return null;
        const newLine = targetLine.replace(re, '$1.get("' + key + '")');
        if (newLine === targetLine) return null;
        const newLines = lines.slice();
        newLines[targetIdx] = newLine;
        return {
          lines: newLines,
          description: 'Replaced direct key access with .get("' + key + '") on line ' + (targetIdx + 1) + '.'
        };
      }
    },
    {
      id: 'py-raise-guard',
      label: 'Add index bounds check',
      appliesTo: p => /\.py$/i.test(p),
      match: /IndexError|list index out of range/i,
      patch: function (doc, lines, targetIdx) {
        const targetLine = lines[targetIdx];
        // Find identifier[idx]
        const re = /([A-Za-z_$][\w$]*)\s*\[\s*([^\]]+)\s*\]/;
        const m = targetLine.match(re);
        if (!m) return null;
        const varName = m[1];
        const idx = m[2].trim();
        const indent = (targetLine.match(/^\s*/) || [''])[0];
        const guard = indent + 'if ' + idx + ' >= len(' + varName + '):\n' +
                      indent + '    raise IndexError(f"index {' + idx + '} out of range for ' +
                      varName + ' (len={len(' + varName + ')})")';
        const newLines = lines.slice();
        newLines.splice(targetIdx, 0, guard);
        return {
          lines: newLines,
          description: 'Added a bounds check before line ' + (targetIdx + 1) +
            ' for indexing ' + varName + '[' + idx + '].'
        };
      }
    },
    {
      id: 'java-null-guard',
      label: 'Add null check',
      appliesTo: p => /\.(java|kt)$/i.test(p),
      match: /NullPointerException/i,
      patch: function (doc, lines, targetIdx) {
        const targetLine = lines[targetIdx];
        // Find the identifier being dereferenced
        const m = targetLine.match(/([A-Za-z_][\w]*)\s*\.\s*\w+\s*\(/);
        if (!m) return null;
        const varName = m[1];
        const indent = (targetLine.match(/^\s*/) || [''])[0];
        const guard = indent + 'if (' + varName + ' == null) {\n' +
                      indent + '    throw new IllegalArgumentException("' + varName + ' must not be null");\n' +
                      indent + '}';
        const newLines = lines.slice();
        newLines.splice(targetIdx, 0, guard);
        return {
          lines: newLines,
          description: 'Inserted a null check before line ' + (targetIdx + 1) +
            ' guarding "' + varName + '".'
        };
      }
    },
    {
      id: 'todo-removal',
      label: 'Remove TODO marker',
      appliesTo: p => /\.(js|ts|jsx|tsx|java|kt|py|rb|go)$/i.test(p),
      match: /\b(TODO|FIXME)\b/i,
      patch: function (doc, lines, targetIdx) {
        const targetLine = lines[targetIdx];
        const newLine = targetLine.replace(/\bTODO\b:?\s*/i, '').replace(/\bFIXME\b:?\s*/i, '');
        if (newLine === targetLine) return null;
        // Don't wipe out a line entirely
        if (newLine.trim().length < 3) return null;
        const newLines = lines.slice();
        newLines[targetIdx] = newLine;
        return {
          lines: newLines,
          description: 'Removed the TODO/FIXME marker from line ' + (targetIdx + 1) + '.'
        };
      }
    },
    {
      id: 'hardcoded-localhost',
      label: 'Externalize localhost',
      appliesTo: p => /\.(js|ts|jsx|tsx|py|java)$/i.test(p),
      match: /localhost|127\.0\.0\.1|econnrefused/i,
      patch: function (doc, lines, targetIdx) {
        const targetLine = lines[targetIdx];
        if (!/['"]https?:\/\/(localhost|127\.0\.0\.1)/.test(targetLine)) return null;
        const newLine = targetLine.replace(
          /['"]https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/,
          '"${process.env.API_BASE_URL || \'http://localhost'
        );
        // This produces broken JS — skip for safety
        return null;
      }
    }
  ];

  // ============================================================
  // HELPERS
  // ============================================================
  function getSavedRepo() {
    const raw = localStorage.getItem('erplorer_gh_repo');
    if (!raw) return null;
    const parts = raw.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  function getToken() {
    return sessionStorage.getItem('gh_token') || null;
  }

  function pickFixablePattern(doc) {
    if (!doc || !doc.file || !doc.text) return null;
    if (doc.file.startsWith('http') || doc.type === 'crawled') return null;
    if (doc.type === 'test-failure') return null;
    for (const p of PATTERNS) {
      if (p.appliesTo && !p.appliesTo(doc.file)) continue;
      if (p.match.test(doc.text)) return p;
    }
    return null;
  }

  /**
   * Fetch the full file content from the repo via raw CDN.
   */
  async function fetchRepoFile(owner, repo, branch, filePath) {
    const url = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + filePath;
    const res = await fetchWithTimeout(url, {}, RAW_FETCH_TIMEOUT);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + filePath);
    return await res.text();
  }

  /**
   * Find the error's line in the file. Uses the doc.line as a hint but
   * verifies by matching the context. Returns -1 if not found.
   */
  function locateTargetLine(lines, doc) {
    const hint = Math.max(0, (doc.line || 1) - 1);

    // Try the hinted line directly
    if (lines[hint] !== undefined) {
      const text = doc.text || '';
      // If the pattern's capture group appears on this line, use it
      if (text && lines[hint].includes(text.split(/[\s'"]+/)[0])) {
        return hint;
      }
    }

    // Search nearby (± 5 lines) for a line containing the first word of the error text
    const firstWord = (doc.text || '').match(/[A-Za-z_$][\w$]{2,}/);
    if (firstWord) {
      for (let offset = 1; offset <= 5; offset++) {
        const above = hint - offset;
        const below = hint + offset;
        if (above >= 0 && lines[above].includes(firstWord[0])) return above;
        if (below < lines.length && lines[below].includes(firstWord[0])) return below;
      }
    }

    // Fall back to the hint if we got this far
    return hint < lines.length ? hint : -1;
  }

  // ============================================================
  // DIFF RENDERER
  // ============================================================
  function renderDiff(originalLines, newLines, centerIdx) {
    // Simple diff: find first index where they differ, and last
    let first = 0;
    while (first < originalLines.length && first < newLines.length &&
           originalLines[first] === newLines[first]) first++;
    let lastO = originalLines.length - 1;
    let lastN = newLines.length - 1;
    while (lastO >= first && lastN >= first && originalLines[lastO] === newLines[lastN]) {
      lastO--; lastN--;
    }
    // Show ±3 lines around the change
    const start = Math.max(0, first - 3);
    const end = Math.min(originalLines.length, lastO + 4);

    const rows = [];
    for (let i = start; i < first; i++) {
      rows.push({ type: 'ctx', num: i + 1, text: originalLines[i] });
    }
    for (let i = first; i <= lastO; i++) {
      rows.push({ type: 'del', num: i + 1, text: originalLines[i] });
    }
    for (let i = first; i <= lastN; i++) {
      rows.push({ type: 'add', num: null, text: newLines[i] });
    }
    for (let i = lastO + 1; i < end; i++) {
      rows.push({ type: 'ctx', num: i + 1, text: originalLines[i] });
    }

    let html = '<div class="qf-diff">';
    for (const r of rows) {
      const cls = r.type === 'add' ? 'qf-add' : r.type === 'del' ? 'qf-del' : 'qf-ctx';
      const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
      html += '<div class="qf-diff-row ' + cls + '">' +
        '<span class="qf-diff-num">' + (r.num || '') + '</span>' +
        '<span class="qf-diff-sign">' + sign + '</span>' +
        '<span class="qf-diff-text">' + esc(r.text) + '</span>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  // ============================================================
  // PANEL
  // ============================================================
  function closePanel() {
    const p = document.querySelector('.quickfix-panel');
    if (p) p.remove();
  }

  function renderPanel(fix, docId) {
    const html = '' +
      '<div class="quickfix-panel">' +
        '<div class="qf-head">' +
          '<span class="qf-title">🔧 Quick Fix</span>' +
          '<span class="qf-badge">' + esc(fix.pattern.label) + '</span>' +
          '<button class="qf-close" onclick="ERplorerQuickFix.closePanel()">✕</button>' +
        '</div>' +
        '<div class="qf-section">' +
          '<div class="qf-label">File</div>' +
          '<div class="qf-value"><code>' + esc(fix.filePath) + '</code></div>' +
        '</div>' +
        '<div class="qf-section">' +
          '<div class="qf-label">Change</div>' +
          '<div class="qf-value">' + esc(fix.description) + '</div>' +
        '</div>' +
        '<div class="qf-section">' +
          '<div class="qf-label">Diff</div>' +
          fix.diffHtml +
        '</div>' +
        '<div class="qf-warning">' +
          '⚠️ This opens a <strong>draft</strong> PR. Review the diff above carefully before continuing. ' +
          'The dev can close or modify it — nothing is merged automatically.' +
        '</div>' +
        '<div class="qf-actions">' +
          '<button class="btn secondary" onclick="ERplorerQuickFix.copyPatch()">📋 Copy new file</button>' +
          '<button class="btn accent" id="qf-open-pr" onclick="ERplorerQuickFix.openDraftPR(\'' + docId + '\')">📤 Open draft PR</button>' +
          '<button class="btn ghost" onclick="ERplorerQuickFix.closePanel()">Cancel</button>' +
        '</div>' +
        '<div id="qf-pr-result"></div>' +
      '</div>';

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const card = document.querySelector('.result[data-doc-id="' + docId + '"]') ||
                 document.getElementById('results');
    if (card) card.appendChild(wrapper.firstChild);
  }

  // ============================================================
  // PUBLIC ACTIONS
  // ============================================================
  async function proposeFor(docId) {
    closePanel();

    const repo = getSavedRepo();
    if (!repo) {
      toast('Set a GitHub repo in Settings first');
      return;
    }
    const token = getToken();
    if (!token) {
      toast('Add a GitHub token in Settings first');
      return;
    }

    const doc = (window.ERplorer && window.ERplorer.getResultById)
      ? window.ERplorer.getResultById(docId)
      : null;
    if (!doc) {
      toast('Could not read the result');
      return;
    }

    const pattern = pickFixablePattern(doc);
    if (!pattern) {
      toast('This error isn\'t in the safe-fix list');
      return;
    }

    toast('Fetching file from repo…');

    // Get the default branch
    const octokit = new (await ensureOctokit())({ auth: token });

    let branch = 'main';
    try {
      const { data } = await octokit.rest.repos.get({ owner: repo.owner, repo: repo.repo });
      if (data.default_branch) branch = data.default_branch;
    } catch (err) {
      toast('Could not read repo info: ' + err.message);
      return;
    }

    // Fetch the full file
    let content;
    try {
      content = await fetchRepoFile(repo.owner, repo.repo, branch, doc.file);
    } catch (err) {
      toast('Could not fetch ' + doc.file + ': ' + err.message);
      return;
    }

    const lines = content.split('\n');
    const targetIdx = locateTargetLine(lines, doc);
    if (targetIdx < 0 || targetIdx >= lines.length) {
      toast('Could not locate the error line in the file');
      return;
    }

    // Apply the patch
    let patched;
    try {
      patched = pattern.patch(doc, lines, targetIdx);
    } catch (err) {
      toast('Fix generation failed: ' + err.message);
      return;
    }
    if (!patched) {
      toast('Could not generate a fix for this error');
      return;
    }

    // Build diff
    const diffHtml = renderDiff(lines, patched.lines, targetIdx);

    STATE.lastFix = {
      pattern: pattern,
      filePath: doc.file,
      originalContent: content,
      newContent: patched.lines.join('\n'),
      description: patched.description,
      diffHtml: diffHtml,
      docId: docId,
      doc: doc,
      owner: repo.owner,
      repo: repo.repo,
      branch: branch
    };

    renderPanel(STATE.lastFix, docId);
  }

  function copyPatch() {
    if (!STATE.lastFix) return;
    const text = STATE.lastFix.newContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('📋 New file content copied');
      }, function () { toast('Copy failed'); });
    }
  }

  async function openDraftPR(docId) {
    if (STATE.busy) return;
    if (!STATE.lastFix) return;

    const btn = document.getElementById('qf-open-pr');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening PR…'; }
    STATE.busy = true;

    const fix = STATE.lastFix;
    const token = getToken();
    if (!token) {
      if (btn) { btn.disabled = false; btn.textContent = '📤 Open draft PR'; }
      STATE.busy = false;
      toast('Token missing');
      return;
    }

    const resultEl = document.getElementById('qf-pr-result');

    try {
      const Octokit = await ensureOctokit();
      const octokit = new Octokit({ auth: token });

      // 1. Base SHA
      const { data: refData } = await octokit.rest.git.getRef({
        owner: fix.owner,
        repo: fix.repo,
        ref: 'heads/' + fix.branch
      });
      const baseSha = refData.object.sha;

      // 2. Current file SHA
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner: fix.owner,
        repo: fix.repo,
        path: fix.filePath,
        ref: fix.branch
      });
      const currentSha = fileData.sha;

      // 3. Create branch
      const branchName = 'erplorer/fix-' + slug(fix.pattern.id + '-' + Date.now());
      await octokit.rest.git.createRef({
        owner: fix.owner,
        repo: fix.repo,
        ref: 'refs/heads/' + branchName,
        sha: baseSha
      });

      // 4. Commit the change
      const commitMessage = 'fix: ' + fix.pattern.label + ' in ' + fix.filePath +
        '\n\n' + fix.description +
        '\n\nGenerated by ERplorer Quick Fix';
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: fix.owner,
        repo: fix.repo,
        path: fix.filePath,
        message: commitMessage,
        content: toBase64(fix.newContent),
        sha: currentSha,
        branch: branchName
      });

      // 5. Open draft PR
      const prTitle = '[ERplorer] ' + fix.pattern.label + ' in ' + fix.filePath;
      const prBody = '' +
        '## ⚠️ Automated fix — review carefully\n\n' +
        'This PR was opened automatically by [ERplorer](https://github.com/suryasticsai/erplorer) Quick Fix.\n\n' +
        '### What changed\n\n' +
        fix.description + '\n\n' +
        '### Original error\n\n' +
        '```\n' + (fix.doc.text || '') + '\n```\n\n' +
        '**Location:** `' + fix.filePath + ':' + (fix.doc.line || '?') + '`\n' +
        '**Type:** ' + (fix.doc.type || 'code') + '\n' +
        '**Pattern:** `' + fix.pattern.id + '`\n\n' +
        '### How this was generated\n\n' +
        'ERplorer matched a deterministic, curated fix pattern against the error and applied it. ' +
        'The change is safe but should still be reviewed by a human before merging.\n\n' +
        '### Actions for the reviewer\n\n' +
        '- [ ] Read the diff\n' +
        '- [ ] Verify the fix is appropriate (not just syntactically correct)\n' +
        '- [ ] Merge or close\n';

      const { data: pr } = await octokit.rest.pulls.create({
        owner: fix.owner,
        repo: fix.repo,
        title: prTitle,
        head: branchName,
        base: fix.branch,
        body: prBody,
        draft: true
      });

      STATE.lastPr = pr;

      if (resultEl) {
        resultEl.innerHTML = '' +
          '<div class="qf-success">' +
            '<div class="qf-success-head">✅ Draft PR opened</div>' +
            '<div class="qf-success-body">' +
              '#' + pr.number + ' · ' + esc(pr.title) +
            '</div>' +
            '<a class="btn accent" href="' + pr.html_url + '" target="_blank" rel="noopener">' +
              '🔗 Open PR in GitHub' +
            '</a>' +
          '</div>';
      }
      if (btn) { btn.style.display = 'none'; }
      toast('✅ Draft PR #' + pr.number + ' opened');
    } catch (err) {
      if (resultEl) {
        resultEl.innerHTML = '<div class="qf-error">❌ Failed: ' + esc(err.message) + '</div>';
      }
      toast('PR failed: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = '📤 Open draft PR'; }
    } finally {
      STATE.busy = false;
    }
  }

  // ============================================================
  // BUTTON INJECTION (MutationObserver)
  // ============================================================
  function canQuickFix() {
    return !!(getSavedRepo() && getToken());
  }

  function attachButtonTo(resultCard) {
    if (!resultCard || resultCard.querySelector('.qf-trigger')) return;

    const docId = resultCard.dataset.docId;
    if (!docId) return;

    const doc = (window.ERplorer && window.ERplorer.getResultById)
      ? window.ERplorer.getResultById(docId)
      : null;
    if (!doc) return;

    const pattern = pickFixablePattern(doc);
    if (!pattern) return;

    const actions = resultCard.querySelector('.result-actions');
    if (!actions) return;

    const btn = document.createElement('button');
    btn.className = 'result-action qf-trigger';
    btn.setAttribute('onclick', 'ERplorerQuickFix.proposeFor(\'' + docId + '\')');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> Propose fix';

    if (!canQuickFix()) {
      btn.title = 'Add a GitHub token and repo in Settings first';
    }

    actions.appendChild(btn);
  }

  function scanForResults(root) {
    if (!root) return;
    if (root.classList && root.classList.contains('result')) {
      attachButtonTo(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('.result').forEach(attachButtonTo);
    }
  }

  function initObserver() {
    const results = document.getElementById('results');
    if (!results) return;
    scanForResults(results);
    const observer = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) scanForResults(node);
        }
      }
    });
    observer.observe(results, { childList: true, subtree: true });

    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        setTimeout(function () { scanForResults(document.getElementById('results')); }, 400);
      });
    }
  }

  // ============================================================
  // BOOT
  // ============================================================
  function boot() {
    setTimeout(initObserver, 500);
  }

  window.ERplorerQuickFix = {
    proposeFor: proposeFor,
    openDraftPR: openDraftPR,
    copyPatch: copyPatch,
    closePanel: closePanel,
    state: function () {
      return {
        hasRepo: !!getSavedRepo(),
        hasToken: !!getToken(),
        lastFix: STATE.lastFix ? STATE.lastFix.pattern.id : null,
        lastPr: STATE.lastPr ? STATE.lastPr.number : null
      };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();