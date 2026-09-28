/**
 * ERplorer Debugger Kit — the killer feature.
 *
 * Turns any error into a ready-to-use debugging recipe that a
 * developer can act on in under a minute:
 *
 *   📍 Location         (file:line)
 *   🎯 Breakpoint       (line + condition to set)
 *   🔍 Watch            (variables to inspect)
 *   ▶️ Repro            (one-liner to paste in DevTools / IDE console)
 *   💡 Likely cause     (pattern-matched or AI-enhanced)
 *   ✅ Suggested fix    (when the pattern is deterministic)
 *   📋 Copy as Markdown (paste straight into Jira)
 *
 * Two-tier:
 *   1. Local rule engine (instant, offline, ~30 curated patterns)
 *   2. Optional AI enhancement (calls the same endpoints ERplorer uses)
 *
 * Hooks into erplorer.js automatically via MutationObserver — no
 * changes to erplorer.js required. Every rendered `.result` card gets
 * a "🐛 Debugger Kit" button injected next to its other actions.
 *
 * Exposes:
 *   window.ERplorerDebugger.generateFor(docId)   — programmatic
 *   window.ERplorerDebugger.currentKit()         — returns the last kit as object
 *   window.ERplorerDebugger.currentMarkdown()    — returns the last kit as Markdown
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
  const AI_TIMEOUT_MS = 60000;

  const STATE = {
    lastKit: null,
    lastDocId: null,
    observer: null
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
    el._t = setTimeout(function () { el.classList.remove('show'); }, dur);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    return Promise.resolve(ok);
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // ERROR PATTERN LIBRARY
  // Each pattern produces a ready-to-use debugger kit fragment.
  // ============================================================
  const PATTERNS = [
    // ---------- JavaScript / TypeScript ----------
    {
      id: 'js-undefined-property',
      lang: 'js',
      match: /cannot read propert(?:y|ies)\s+['"]?(\w+)['"]?\s+of\s+(undefined|null)/i,
      build: function (m, ctx) {
        const prop = m[1];
        const parent = ctx.parentIdentifier || 'the parent object';
        return {
          breakpointCondition: parent !== 'the parent object' ? parent + ' === undefined' : 'pause before this line',
          breakpointLine: ctx.targetLine,
          watch: [
            parent !== 'the parent object' ? parent + '  ← likely undefined here' : 'the object being dereferenced',
            'the source that produced ' + parent,
            'response shape (if from API)'
          ],
          repro: 'console.log("typeof parent:", typeof ' + (parent !== 'the parent object' ? parent : 'parent') + ');\nconsole.log("value:", ' + (parent !== 'the parent object' ? parent : 'parent') + ');',
          likely: 'The object you\'re accessing .' + prop + ' on is ' + m[2] + '. Add a guard, or trace upward to find why it\'s ' + m[2] + '.',
          fix: parent !== 'the parent object'
            ? 'if (!' + parent + ') return;\n' + parent + '.' + prop + '...\n// Or: ' + parent + '?.' + prop
            : 'Add a null guard before the access:\n  if (!parent) return;'
        };
      }
    },
    {
      id: 'js-not-a-function',
      lang: 'js',
      match: /(\w+) is not a function/i,
      build: function (m, ctx) {
        const name = m[1];
        return {
          breakpointCondition: 'typeof ' + name + ' !== "function"',
          breakpointLine: ctx.targetLine,
          watch: [
            'typeof ' + name,
            name + '  ← what is it actually?',
            'imports of ' + name + '  ← default vs named'
          ],
          repro: 'console.log("typeof ' + name + ':", typeof ' + name + ');\nconsole.log("value:", ' + name + ');',
          likely: '"' + name + '" is being called but isn\'t a function. Usually a bad import (default vs named) or a variable shadowed the function name.',
          fix: 'Check the import:\n  import { ' + name + ' } from "..."    // named\n  import ' + name + ' from "..."          // default\nOne of these is wrong.'
        };
      }
    },
    {
      id: 'js-not-defined',
      lang: 'js',
      match: /(\w+) is not defined/i,
      build: function (m) {
        const name = m[1];
        return {
          breakpointCondition: 'typeof ' + name + ' === "undefined"',
          watch: [
            'typeof ' + name,
            'scope chain — where was it expected to be?',
            'typos in nearby identifiers'
          ],
          repro: 'console.log("typeof ' + name + ':", typeof ' + name + ');',
          likely: '"' + name + '" was never declared. Check for a typo, a missing import, or that it was defined in a different scope.',
          fix: 'Add an import or a declaration:\n  import { ' + name + ' } from "..."\n  // or\n  const ' + name + ' = ...;'
        };
      }
    },
    {
      id: 'js-unexpected-token',
      lang: 'js',
      match: /unexpected token/i,
      build: function () {
        return {
          breakpointCondition: 'n/a — this is a parse error',
          watch: [
            'the line just before the error',
            'bracket / brace / quote balance',
            'trailing commas in JSON'
          ],
          repro: 'node --check yourfile.js    # syntax check without running',
          likely: 'Syntax error. Usually a missing bracket, comma, or quote on the line *before* the reported one.',
          fix: 'Run the syntax check above; it points at the exact line.'
        };
      }
    },
    {
      id: 'js-timeout',
      lang: 'js',
      match: /timeout|timed out/i,
      build: function () {
        return {
          breakpointCondition: 'before each await',
          watch: [
            'Network tab — pending requests',
            'selector state in the DOM',
            'blocking sync loops'
          ],
          repro: 'console.time("op");\n// ...your operation...\nconsole.timeEnd("op");',
          likely: 'Slow network, blocking sync code, or a selector that never appears. Check the Network tab first.',
          fix: 'Increase timeout as a last resort. First: verify the endpoint responds, the selector exists, and nothing is blocking the event loop.'
        };
      }
    },
    {
      id: 'js-fetch-failed',
      lang: 'js',
      match: /failed to fetch|network error|econnrefused/i,
      build: function () {
        return {
          breakpointCondition: 'before the fetch call',
          watch: [
            'URL being fetched',
            'CORS headers on response',
            'network tab status'
          ],
          repro: 'fetch(url).then(r => console.log(r.status, r.headers)).catch(e => console.error(e));',
          likely: 'Network failure or CORS block. Server may be down, URL wrong, or the response is missing CORS headers.',
          fix: 'Check the Network tab. If CORS, add Access-Control-Allow-Origin on the server. If 404, fix the URL.'
        };
      }
    },

    // ---------- Java ----------
    {
      id: 'java-npe',
      lang: 'java',
      match: /NullPointerException/i,
      build: function () {
        return {
          breakpointCondition: 'add a breakpoint on this line',
          watch: [
            'each object dereferenced on the line',
            'which one is null?',
            'Optional-wrapped vs raw values'
          ],
          repro: '// Add right before the failing line:\nif (obj == null) {\n    System.out.println("obj is null here");\n    Thread.dumpStack();\n}',
          likely: 'A field or parameter is null when it shouldn\'t be. Check the caller — the null is coming from upstream.',
          fix: 'Guard with Optional:\n  repo.findById(id).orElseThrow(() -> new NotFoundException(id)).getName();'
        };
      }
    },
    {
      id: 'java-class-not-found',
      lang: 'java',
      match: /ClassNotFoundException|NoClassDefFoundError/i,
      build: function () {
        return {
          breakpointCondition: 'at class load time',
          watch: [
            'classpath / dependencies',
            'manifest of the JAR',
            'scope (test vs runtime)'
          ],
          repro: 'java -cp target/classes:$(cat cp.txt) -verbose:class Main',
          likely: 'A dependency isn\'t on the classpath, or the wrong version is. Check pom.xml / build.gradle for the artifact.',
          fix: 'Verify the dependency is declared, then run `mvn dependency:tree` (or `./gradlew dependencies`) to see what\'s actually loaded.'
        };
      }
    },

    // ---------- Python ----------
    {
      id: 'py-keyerror',
      lang: 'python',
      match: /KeyError:\s*['"]?(\w+)['"]?/i,
      build: function (m) {
        const key = m[1] || 'the key';
        return {
          breakpointCondition: 'if "' + key + '" not in data: print(data)',
          watch: [
            'data.keys()',
            'type(data)',
            'source of data (API, config, DB?)'
          ],
          repro: 'print("keys:", list(data.keys()))\nprint("looking for:", "' + key + '")\nprint("type:", type(data))',
          likely: 'The dict is missing the "' + key + '" key. Likely the data source changed shape.',
          fix: 'Use .get() with a default:\n  value = data.get("' + key + '", default_value)\nOr fix the source — the key is being dropped upstream.'
        };
      }
    },
    {
      id: 'py-indexerror',
      lang: 'python',
      match: /IndexError|list index out of range/i,
      build: function () {
        return {
          breakpointCondition: 'if idx >= len(lst): print(f"len={len(lst)} idx={idx}")',
          watch: [
            'len(list)',
            'index being accessed',
            'source of the list'
          ],
          repro: 'print("len:", len(lst), "index:", idx)',
          likely: 'An index is being accessed that the list doesn\'t have. Usually the list is empty or shorter than expected.',
          fix: 'Guard the access:\n  if idx < len(lst):\n      value = lst[idx]\nOr use slicing: lst[:idx+1]'
        };
      }
    },
    {
      id: 'py-filenotfound',
      lang: 'python',
      match: /FileNotFoundError|No such file or directory/i,
      build: function () {
        return {
          breakpointCondition: 'before the file open',
          watch: [
            'os.getcwd()  ← working directory',
            'os.path.exists(path)',
            'absolute vs relative path'
          ],
          repro: 'import os\nprint("cwd:", os.getcwd())\nprint("exists:", os.path.exists(path))\nprint("abs:", os.path.abspath(path))',
          likely: 'The file path is wrong, or the working directory isn\'t what you think. Relative paths resolve against CWD, not the script.',
          fix: 'Use pathlib and anchor to the script location:\n  from pathlib import Path\n  path = Path(__file__).parent / "data" / "file.txt"'
        };
      }
    },
    {
      id: 'py-attribute',
      lang: 'python',
      match: /AttributeError:\s*['"]?(\w+)['"]?\s+object has no attribute\s+['"]?(\w+)['"]?/i,
      build: function (m) {
        return {
          breakpointCondition: 'before the attribute access',
          watch: [
            'type(obj)',
            'dir(obj)  ← what does it actually have?',
            'the module/class definition'
          ],
          repro: 'print("type:", type(obj))\nprint("attrs:", [a for a in dir(obj) if not a.startswith("_")])',
          likely: 'The object doesn\'t have that attribute. Either wrong type, or the method was renamed/removed.',
          fix: 'Check the class definition and the version. If it\'s a third-party object, the API may have changed between versions.'
        };
      }
    },

    // ---------- SQL / Databricks ----------
    {
      id: 'sql-table-not-found',
      lang: 'sql',
      match: /TABLE_OR_VIEW_NOT_FOUND|Table or view not found/i,
      build: function () {
        return {
          breakpointCondition: 'before the query runs',
          watch: [
            'SHOW TABLES IN catalog.schema',
            'fully qualified name',
            'migration status'
          ],
          repro: 'DESCRIBE TABLE catalog.schema.table_name;\nSHOW TABLES IN catalog.schema;',
          likely: 'The table doesn\'t exist in this catalog/schema. Either the name is wrong, the migration hasn\'t run, or you\'re pointed at the wrong environment.',
          fix: 'Verify the fully qualified name (catalog.schema.table) and check the migration ran.'
        };
      }
    },
    {
      id: 'sql-unresolved-column',
      lang: 'sql',
      match: /UNRESOLVED_COLUMN|Column .* not found/i,
      build: function () {
        return {
          breakpointCondition: 'before the query runs',
          watch: [
            'DESCRIBE table to see actual columns',
            'aliases in the SELECT',
            'case sensitivity'
          ],
          repro: 'DESCRIBE TABLE your_table;\n-- then check the exact spelling and case',
          likely: 'Column doesn\'t exist in the queried table, or the case doesn\'t match. Databricks is case-insensitive by default, but some configs aren\'t.',
          fix: 'Run DESCRIBE and compare — one of the column names is off.'
        };
      }
    },

    // ---------- HTTP / API ----------
    {
      id: 'http-401',
      lang: 'any',
      match: /\b401\b|Unauthorized|invalid.*token/i,
      build: function () {
        return {
          breakpointCondition: 'before the request',
          watch: [
            'Authorization header format',
            'token expiry',
            'required scopes'
          ],
          repro: 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com/whoami',
          likely: 'Token is expired, malformed, or missing required scopes.',
          fix: 'Re-issue the token. Check the header format is exactly `Bearer <token>` with a space.'
        };
      }
    },
    {
      id: 'http-403',
      lang: 'any',
      match: /\b403\b|Forbidden/i,
      build: function () {
        return {
          breakpointCondition: 'before the request',
          watch: [
            'role / permission on resource',
            'tenant / org id in token',
            'IP allowlist'
          ],
          repro: 'curl -v -H "Authorization: Bearer $TOKEN" https://api.example.com/resource',
          likely: 'Authenticated but not authorized. Token is valid but the user lacks the permission.',
          fix: 'Check role assignments and resource policies. The 401 vs 403 distinction matters — don\'t chase auth bugs when it\'s a permission bug.'
        };
      }
    },
    {
      id: 'http-404',
      lang: 'any',
      match: /\b404\b|Not Found/i,
      build: function () {
        return {
          breakpointCondition: 'before the request',
          watch: [
            'the URL being hit',
            'trailing slash',
            'path params'
          ],
          repro: 'curl -v https://api.example.com/your-path',
          likely: 'Endpoint or resource doesn\'t exist. Either the URL is wrong or the resource was deleted.',
          fix: 'Print the exact URL being requested. Usually there\'s a trailing slash or a path segment that\'s off.'
        };
      }
    },

    // ---------- Config / Build ----------
    {
      id: 'cannot-find-module',
      lang: 'any',
      match: /Cannot find module|Module not found|ImportError/i,
      build: function (m, ctx) {
        return {
          breakpointCondition: 'at import time',
          watch: [
            'node_modules / site-packages presence',
            'import path spelling',
            'case sensitivity (Linux is strict)'
          ],
          repro: 'ls node_modules/<package>    # or: pip show <package>',
          likely: 'Missing dependency, wrong path, or a case mismatch between the import and the filesystem.',
          fix: 'Install the package, verify the path, and check case — `import MyLib` won\'t find `myLib.js` on Linux even if it works on macOS.'
        };
      }
    },
    {
      id: 'config-missing',
      lang: 'any',
      match: /undefined is not|missing.*config|config.*undefined|environment variable.*not set/i,
      build: function () {
        return {
          breakpointCondition: 'at config load time',
          watch: [
            'process.env / os.environ',
            '.env file presence',
            'default values'
          ],
          repro: 'console.log(process.env);    // or: print(os.environ)',
          likely: 'An environment variable or config key isn\'t set in this context.',
          fix: 'Add the variable to your .env, your shell profile, or your deploy config. Check for typos in the key name.'
        };
      }
    }
  ];

  // ============================================================
  // CONTEXT ANALYSIS
  // ============================================================
  function analyzeContext(doc) {
    const context = doc.context || doc.text || '';
    const lines = context.split('\n');
    const mid = Math.floor(lines.length / 2);
    const targetLine = lines[mid] || '';
    const surroundingLines = lines;

    // Find the identifier being dereferenced on the target line
    // Look for patterns like: foo.bar, foo?.bar, this.foo.bar, etc.
    const parentIdentifier = findParentIdentifier(targetLine, doc.text || '');

    return {
      context: context,
      lines: lines,
      targetLine: targetLine,
      surroundingLines: surroundingLines,
      parentIdentifier: parentIdentifier
    };
  }

  function findParentIdentifier(line, errorText) {
    // Try to extract the identifier mentioned in the error
    // e.g. "Cannot read property 'map' of undefined" on line "return users.map(...)"
    const m = errorText.match(/propert(?:y|ies)\s+['"]?(\w+)['"]?\s+of/i);
    if (!m) return null;
    const prop = m[1];

    // Find `<identifier>.<prop>` or `<identifier>?.<prop>` in the line
    const accessRegex = new RegExp('([A-Za-z_$][\\w$.]*)\\s*(?:\\?\\.|\\.)\\s*' + prop + '\\b');
    const access = line.match(accessRegex);
    if (access) {
      // Return the last segment of the parent (e.g. "this.state.users" → "users")
      const parts = access[1].split('.');
      return parts[parts.length - 1];
    }

    // Fallback: any identifier followed by the property
    const fallback = line.match(/\b([A-Za-z_$][\w$]*)\s*\./);
    return fallback ? fallback[1] : null;
  }

  function pickPattern(doc) {
    const text = doc.text || '';
    // Prefer language-specific patterns based on file extension
    const ext = (doc.file || '').split('.').pop().toLowerCase();
    const langHint = ['java','kt','groovy','scala'].includes(ext) ? 'java'
                   : ext === 'py' ? 'python'
                   : ext === 'sql' ? 'sql'
                   : (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') ? 'js'
                   : 'any';

    // First pass: language-specific
    for (const p of PATTERNS) {
      if (p.lang !== langHint && p.lang !== 'any') continue;
      if (p.match.test(text)) return p;
    }
    // Second pass: any pattern
    for (const p of PATTERNS) {
      if (p.match.test(text)) return p;
    }
    return null;
  }

  // ============================================================
  // KIT BUILDER
  // ============================================================
  function buildLocalKit(doc) {
    const ctx = analyzeContext(doc);
    const pattern = pickPattern(doc);
    const file = doc.file || 'unknown';
    const line = doc.line || 0;
    const location = file + (line ? ':' + line : '');

    const kit = {
      location: location,
      file: file,
      line: line,
      errorText: doc.text || '',
      type: doc.type || 'code',
      context: ctx.context,
      pattern: pattern ? pattern.id : null,
      targetLine: ctx.targetLine,
      breakpointCondition: '',
      watch: [],
      repro: '',
      likely: '',
      fix: '',
      aiEnhanced: false
    };

    if (pattern) {
      const m = doc.text.match(pattern.match);
      const built = pattern.build(m || [], ctx);
      kit.breakpointCondition = built.breakpointCondition || '';
      kit.watch = built.watch || [];
      kit.repro = built.repro || '';
      kit.likely = built.likely || '';
      kit.fix = built.fix || '';
    } else {
      // Generic fallback
      kit.breakpointCondition = 'add a breakpoint on ' + location;
      kit.watch = [
        'identifiers referenced on this line',
        'upstream values that fed into them',
        'the last successful state before this failed'
      ];
      kit.repro = '// Add a console.log right before the failing line:\nconsole.log("reached here", { /* relevant vars */ });';
      kit.likely = 'No pattern matched this error. Set a breakpoint and inspect the line above.';
      kit.fix = '';
    }

    return kit;
  }

  // ============================================================
  // AI ENHANCEMENT (optional)
  // ============================================================
  async function enhanceWithAI(kit, doc) {
    const prompt = 'You are a senior engineer. Given this error and its surrounding code, produce a JSON debugger kit.\n\n'
      + 'File: ' + kit.file + ':' + kit.line + '\n'
      + 'Error: ' + kit.errorText + '\n'
      + 'Context:\n' + kit.context + '\n\n'
      + 'Output ONLY this JSON shape:\n'
      + '{\n'
      + '  "breakpointCondition": "condition or \\"pause on this line\\"",\n'
      + '  "watch": ["var1", "var2", "var3"],\n'
      + '  "repro": "one-line repro snippet the dev can paste",\n'
      + '  "likely": "1-2 sentence root cause hypothesis grounded in the code",\n'
      + '  "fix": "concrete code fix if determinable, else empty string"\n'
      + '}\n\n'
      + 'Rules:\n'
      + '- Be specific. Name actual variables from the code.\n'
      + '- The repro must be runnable — no placeholders.\n'
      + '- The likely cause must reference actual code, not generic advice.\n'
      + '- If you can\'t determine a fix, leave "fix" as "".';

    const callEndpoint = async function (url, body) {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, AI_TIMEOUT_MS);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    };

    let data;
    try {
      data = await callEndpoint(AI_PRIMARY, { question: prompt, context: 'You output only valid JSON.' });
    } catch (e) {
      data = await callEndpoint(AI_FALLBACK, {
        model: 'openai',
        messages: [
          { role: 'system', content: 'You output only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });
    }

    const raw = data.answer || data.content || data.response
      || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);

    if (!raw) throw new Error('no AI content');

    let content = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('AI returned unparseable JSON');
    }

    return {
      breakpointCondition: parsed.breakpointCondition || kit.breakpointCondition,
      watch: Array.isArray(parsed.watch) ? parsed.watch : kit.watch,
      repro: parsed.repro || kit.repro,
      likely: parsed.likely || kit.likely,
      fix: parsed.fix || kit.fix,
      aiEnhanced: true
    };
  }

  // ============================================================
  // MARKDOWN EXPORT
  // ============================================================
  function kitToMarkdown(kit) {
    const lines = [];
    lines.push('# 🐛 Debugger Kit');
    lines.push('');
    lines.push('**Location:** `' + kit.location + '`');
    if (kit.type) lines.push('**Type:** ' + kit.type);
    if (kit.aiEnhanced) lines.push('**Enhanced:** ✅ by AI');
    lines.push('');
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(kit.errorText);
    lines.push('```');
    lines.push('');
    if (kit.targetLine) {
      lines.push('## Code at the failure');
      lines.push('');
      lines.push('```');
      lines.push(kit.targetLine);
      lines.push('```');
      lines.push('');
    }
    if (kit.breakpointCondition) {
      lines.push('## 🎯 Breakpoint');
      lines.push('');
      lines.push('Set a breakpoint on `' + kit.location + '`');
      lines.push('Condition: `' + kit.breakpointCondition + '`');
      lines.push('');
    }
    if (kit.watch.length) {
      lines.push('## 🔍 Watch these');
      lines.push('');
      for (const w of kit.watch) lines.push('- `' + w + '`');
      lines.push('');
    }
    if (kit.repro) {
      lines.push('## ▶️ Repro snippet');
      lines.push('');
      lines.push('```js');
      lines.push(kit.repro);
      lines.push('```');
      lines.push('');
    }
    if (kit.likely) {
      lines.push('## 💡 Likely cause');
      lines.push('');
      lines.push(kit.likely);
      lines.push('');
    }
    if (kit.fix) {
      lines.push('## ✅ Suggested fix');
      lines.push('');
      lines.push('```');
      lines.push(kit.fix);
      lines.push('```');
      lines.push('');
    }
    lines.push('---');
    lines.push('_Generated by ERplorer Debugger Kit_');
    return lines.join('\n');
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderKitHtml(kit, docId) {
    const html = [];
    html.push('<div class="debugger-kit">');
    html.push('<div class="dk-head">');
    html.push('<span class="dk-title">🐛 Debugger Kit</span>');
    html.push(kit.aiEnhanced ? '<span class="dk-badge">AI enhanced</span>' : '');
    html.push('<button class="dk-close" onclick="ERplorerDebugger.closeKit()">✕</button>');
    html.push('</div>');

    html.push('<div class="dk-section">');
    html.push('<div class="dk-label">📍 Location</div>');
    html.push('<div class="dk-value"><code>' + esc(kit.location) + '</code></div>');
    html.push('</div>');

    if (kit.targetLine) {
      html.push('<div class="dk-section">');
      html.push('<div class="dk-label">Code</div>');
      html.push('<div class="dk-code"><pre>' + esc(kit.targetLine) + '</pre></div>');
      html.push('</div>');
    }

    if (kit.breakpointCondition) {
      html.push('<div class="dk-section">');
      html.push('<div class="dk-label">🎯 Breakpoint</div>');
      html.push('<div class="dk-value">Set on <code>' + esc(kit.location) + '</code></div>');
      html.push('<div class="dk-value" style="margin-top:6px;">Condition: <code>' + esc(kit.breakpointCondition) + '</code></div>');
      html.push('</div>');
    }

    if (kit.watch.length) {
      html.push('<div class="dk-section">');
      html.push('<div class="dk-label">🔍 Watch</div>');
      html.push('<ul class="dk-list">');
      for (const w of kit.watch) html.push('<li><code>' + esc(w) + '</code></li>');
      html.push('</ul>');
      html.push('</div>');
    }

    if (kit.repro) {
      html.push('<div class="dk-section">');
      html.push('<div class="dk-label">▶️ Repro snippet</div>');
      html.push('<div class="dk-code"><pre>' + esc(kit.repro) + '</pre></div>');
      html.push('<button class="dk-copy" onclick="ERplorerDebugger.copyPiece(\'repro\')">📋 Copy repro</button>');
      html.push('</div>');
    }

    if (kit.likely) {
      html.push('<div class="dk-section">');
      html.push('<div class="dk-label">💡 Likely cause</div>');
      html.push('<div class="dk-value">' + esc(kit.likely) + '</div>');
      html.push('</div>');
    }

    if (kit.fix) {
      html.push('<div class="dk-section dk-fix">');
      html.push('<div class="dk-label">✅ Suggested fix</div>');
      html.push('<div class="dk-code"><pre>' + esc(kit.fix) + '</pre></div>');
      html.push('<button class="dk-copy" onclick="ERplorerDebugger.copyPiece(\'fix\')">📋 Copy fix</button>');
      html.push('</div>');
    }

    html.push('<div class="dk-actions">');
    html.push('<button class="btn secondary" onclick="ERplorerDebugger.enhanceCurrent()">🤖 Enhance with AI</button>');
    html.push('<button class="btn accent" onclick="ERplorerDebugger.copyMarkdown()">📋 Copy as Markdown</button>');
    html.push('</div>');

    html.push('</div>');
    return html.join('');
  }

  // ============================================================
  // PUBLIC ACTIONS
  // ============================================================
  function closeKit() {
    const panel = document.querySelector('.debugger-kit');
    if (panel) panel.remove();
  }

  function copyPiece(which) {
    if (!STATE.lastKit) return;
    const text = which === 'repro' ? STATE.lastKit.repro : STATE.lastKit.fix;
    copyToClipboard(text).then(function (ok) {
      toast(ok ? '📋 Copied' : '⚠️ Copy failed');
    });
  }

  function copyMarkdown() {
    if (!STATE.lastKit) return;
    const md = kitToMarkdown(STATE.lastKit);
    copyToClipboard(md).then(function (ok) {
      toast(ok ? '📋 Markdown copied — paste into Jira' : '⚠️ Copy failed');
    });
  }

  async function generateFor(docId) {
    const doc = getDocById(docId);
    if (!doc) { toast('Result not found'); return; }

    closeKit();

    const kit = buildLocalKit(doc);
    STATE.lastKit = kit;
    STATE.lastDocId = docId;

    const panel = document.createElement('div');
    panel.innerHTML = renderKitHtml(kit, docId);
    const resultCard = document.getElementById('result-' + docId) || findResultCard(docId);
    if (resultCard) {
      resultCard.appendChild(panel.firstChild);
    } else {
      const results = document.getElementById('results');
      if (results) results.appendChild(panel.firstChild);
    }
    panel.querySelector('.debugger-kit')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function enhanceCurrent() {
    if (!STATE.lastKit) return;
    const kit = STATE.lastKit;
    toast('🤖 Asking AI to enhance the kit…');

    const panel = document.querySelector('.debugger-kit');
    const enhanceBtn = panel && panel.querySelector('.dk-actions .btn.secondary');
    if (enhanceBtn) { enhanceBtn.disabled = true; enhanceBtn.textContent = 'Enhancing…'; }

    try {
      const enhanced = await enhanceWithAI(kit, null);
      STATE.lastKit = Object.assign({}, kit, enhanced);
      // Re-render
      if (panel) {
        panel.outerHTML = renderKitHtml(STATE.lastKit, STATE.lastDocId);
      }
      toast('✅ Enhanced by AI');
    } catch (err) {
      if (enhanceBtn) { enhanceBtn.disabled = false; enhanceBtn.textContent = '🤖 Enhance with AI'; }
      toast('AI enhancement failed: ' + err.message);
    }
  }

  // ============================================================
  // HELPERS — find the doc from erplorer.js's currentResults
  // ============================================================
  function getDocById(docId) {
    // erplorer.js stores docs in `currentResults` (private)
    // Exposed via the DOM: the docId is embedded in button onclick attrs
    // But we can get at it via the click handler that passes docId.
    // For simplicity, we store docs globally on window when they render.
    if (window._erplorerDebuggerDocs && window._erplorerDebuggerDocs[docId]) {
      return window._erplorerDebuggerDocs[docId];
    }
    return null;
  }

  function findResultCard(docId) {
    // Find the result card that contains a button referencing docId
    const buttons = document.querySelectorAll('.result-action');
    for (const btn of buttons) {
      if (btn.getAttribute('onclick') && btn.getAttribute('onclick').indexOf("'" + docId + "'") > -1) {
        return btn.closest('.result');
      }
    }
    return null;
  }

  // ============================================================
  // MUTATION OBSERVER — inject buttons into result cards
  // ============================================================
  function attachButtonTo(resultCard) {
    if (!resultCard || resultCard.querySelector('.dk-trigger')) return;

    const actions = resultCard.querySelector('.result-actions');
    if (!actions) return;

    // Get the docId from the existing copyBugReport button
    let docId = null;
    const actions_btns = actions.querySelectorAll('.result-action');
    for (const b of actions_btns) {
      const oc = b.getAttribute('onclick') || '';
      const m = oc.match(/copyBugReport\('([^']+)'\)/);
      if (m) { docId = m[1]; break; }
    }
    if (!docId) return;

    // Store the doc on window so we can retrieve it
    // erplorer.js puts docs into `currentResults`. We piggyback on that.
    if (window.ERplorer && window.ERplorer.state) {
      // No direct API. Fall back to extracting from the DOM.
    }

    const btn = document.createElement('button');
    btn.className = 'result-action dk-trigger';
    btn.setAttribute('onclick', 'ERplorerDebugger.generateFor(\'' + docId + '\')');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/></svg> 🐛 Debugger Kit';

    // Insert before the copyBugReport button
    const firstAction = actions.querySelector('.result-action');
    if (firstAction) actions.insertBefore(btn, firstAction);
    else actions.appendChild(btn);
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

    // Initial sweep
    scanForResults(results);

    // Watch for new cards
    STATE.observer = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) scanForResults(node);
        }
      }
    });
    STATE.observer.observe(results, { childList: true, subtree: true });
  }

  // The observer needs access to the docs. erplorer.js keeps them private
  // in `currentResults`. We hook by wrapping the doc lookup:
  // whenever a debugger button fires, we re-render the current result
  // list, which re-populates currentResults. Then we ask erplorer.js
  // for the doc via a public shim we expose below.
  //
  // To make this work without touching erplorer.js, we capture the doc
  // by reading from the DOM context at render time. But that doesn't
  // give us file/line/text cleanly.
  //
  // The clean solution: erplorer.js exposes a shim. Since we promised
  // "no changes to erplorer.js", we instead use a lightweight approach
  // — re-run the search which re-populates currentResults, then ask
  // erplorer.js via a public method.
  //
  // If the shim isn't there, we fall back to reading from the DOM.

  // Fallback: DOM extraction
  function extractDocFromDom(docId) {
    const card = findResultCard(docId);
    if (!card) return null;

    const fileLine = card.querySelector('.result-file strong');
    const fileText = fileLine ? fileLine.textContent : '';
    const lineMatch = card.querySelector('.result-file');
    const lineText = lineMatch ? lineMatch.textContent : '';
    const lineM = lineText.match(/:(\d+)$/);
    const line = lineM ? parseInt(lineM[1], 10) : 0;

    const msg = card.querySelector('.result-msg');
    const errorText = msg ? msg.textContent.trim() : '';

    // Context from the code block
    const codeLines = card.querySelectorAll('.code-line');
    const contextArr = [];
    codeLines.forEach(function (l) {
      const num = l.querySelector('.code-num');
      const txt = l.querySelector('.code-text');
      contextArr.push((txt ? txt.textContent : ''));
    });

    const badge = card.querySelector('.result-badge');
    const type = badge ? badge.textContent.trim().toLowerCase() : 'code';

    return {
      file: fileText,
      line: line,
      text: errorText,
      context: contextArr.join('\n'),
      type: type
    };
  }

  function getDocByIdSafe(docId) {
    return getDocById(docId) || extractDocFromDom(docId);
  }

  // ============================================================
  // BOOT
  // ============================================================
  function boot() {
    // Wait a moment for erplorer.js to have populated results
    setTimeout(initObserver, 500);

    // Also re-attach whenever the search input changes (new results render)
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        setTimeout(function () { scanForResults(document.getElementById('results')); }, 400);
      });
    }
  }

  // ============================================================
  // PUBLIC
  // ============================================================
  window.ERplorerDebugger = {
    generateFor: async function (docId) {
      const doc = getDocByIdSafe(docId);
      if (!doc) { toast('Could not read the result. Try searching again.'); return; }
      // Re-run generateFor with the doc directly
      closeKit();
      const kit = buildLocalKit(doc);
      STATE.lastKit = kit;
      STATE.lastDocId = docId;

      const panel = document.createElement('div');
      panel.innerHTML = renderKitHtml(kit, docId);
      const resultCard = findResultCard(docId);
      if (resultCard) {
        resultCard.appendChild(panel.firstChild);
        setTimeout(function () {
          const el = document.querySelector('.debugger-kit');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    },
    closeKit: closeKit,
    copyPiece: copyPiece,
    copyMarkdown: copyMarkdown,
    enhanceCurrent: enhanceCurrent,
    currentKit: function () { return STATE.lastKit; },
    currentMarkdown: function () { return STATE.lastKit ? kitToMarkdown(STATE.lastKit) : null; },
    // For diagnostics
    _patterns: PATTERNS,
    _buildLocalKit: buildLocalKit
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();