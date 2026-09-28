#!/usr/bin/env node
/**
 * ERplorer index builder.
 *
 * Scans the repository for error messages across:
 *   - JavaScript / TypeScript:  throw new Error, console.error
 *   - Java / Kotlin / Groovy / Scala:  throw new XxxException, LOG.error
 *   - Python / PySpark:  raise, dbutils.notebook.exit, logger.error
 *   - Databricks notebooks:  python cells within .ipynb
 *   - SQL:  RAISE EXCEPTION, SIGNAL SQLSTATE, Databricks error codes
 *   - Config:  yaml, yml, json, properties, env — error/failure/message keys
 *   - Playwright:  test-results.json failures (if present)
 *
 * Emits search-index.json at the repo root.
 *
 * Usage:
 *   node scripts/build-index.js
 *
 * Environment:
 *   ERPLORER_SCAN=./path    — override the scan root (default: cwd)
 *   ERPLORER_OUT=./path     — override the output path (default: ./search-index.json)
 *   ERPLORER_VERBOSE=1      — log every file scanned
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIG
// ============================================================
const ROOT_DIR = process.env.ERPLORER_SCAN || '.';
const TEST_RESULTS = process.env.ERPLORER_TEST_RESULTS || './test-results.json';
const OUTPUT = process.env.ERPLORER_OUT || './search-index.json';
const VERBOSE = process.env.ERPLORER_VERBOSE === '1';

// Directories that never contain source
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'vendor',
  'third_party',
  'bower_components',
  '.idea',
  '.vscode',
  '.DS_Store'
]);

// Extension → language tag
const EXT_LANG = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.groovy': 'groovy',
  '.gradle': 'groovy',
  '.scala': 'scala',
  '.py': 'python',
  '.pyw': 'python',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.properties': 'properties',
  '.env': 'properties',
  '.env.local': 'properties',
  '.env.example': 'properties',
  '.ipynb': 'notebook'
};

// ============================================================
// ERROR EXTRACTION PATTERNS
// Each pattern's first capture group is the error message.
// ============================================================
const PATTERNS = {
  js: [
    // throw new Error('msg')  |  Error("msg")  |  console.error(`msg`)
    /(?:throw new Error|Error\(|console\.error)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
  ],
  ts: [
    /(?:throw new Error|Error\(|console\.error)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
  ],
  java: [
    // throw new XxxException("msg")
    /throw new \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g,
    // LOG.error("msg", ...)  |  logger.warn("msg", ...)
    /LOG(?:GER)?\.(?:error|warn|severe|log)\s*\(\s*(?:[^,)]+,\s*)?"([^"]+)"/gi,
    /logger\.(?:error|warn|severe|log)\s*\(\s*(?:[^,)]+,\s*)?"([^"]+)"/gi
  ],
  kotlin: [
    /throw \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g,
    /logger\.(?:error|warn)\s*\(\s*(?:[^,)]+,\s*)?"([^"]+)"/gi
  ],
  groovy: [
    /throw new \w*(?:Exception|Error)\s*\(\s*'([^']+)'/g,
    /throw new \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g
  ],
  scala: [
    /throw new \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g
  ],
  python: [
    // raise ValueError('msg')  |  raise ValueError(f"msg")
    /raise \w+(?:Error|Exception)\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g,
    // dbutils.notebook.exit('msg')
    /dbutils\.notebook\.exit\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g,
    // logger.error('msg')  |  logging.error('msg')
    /(?:logger|logging)\.(?:error|warning|critical|exception)\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g
  ],
  sql: [
    // RAISE EXCEPTION 'msg'
    /RAISE\s+EXCEPTION\s+'([^']+)'/gi,
    // SIGNAL SQLSTATE 'xxx' SET MESSAGE_TEXT = 'msg'
    /SIGNAL\s+SQLSTATE\s+'[^']*'\s+SET\s+MESSAGE_TEXT\s*=\s*'([^']+)'/gi,
    // Databricks error codes as bare identifiers
    /\b(INVALID_FORMAT|PATH_NULL|MALFORMED_FILE_REF|TABLE_OR_VIEW_NOT_FOUND|PARSE_SYNTAX_ERROR|UNRESOLVED_COLUMN|UNRESOLVED_ROUTINE|SCHEMA_NOT_FOUND|COLUMN_ALREADY_EXISTS|DELTA_MISSING_TRANSACTION_LOG|DELTA_VIOLATION)\b/g
  ],
  yaml: [
    // error: "message"  |  failure: message
    /^\s*(?:error|failure|reason|message)\s*:\s*["']?([^"'\n#]+)/gim
  ],
  properties: [
    // any.key.error=message  |  error.message: value
    /^\s*[\w.-]*error[\w.-]*\s*[:=]\s*(.+)$/gim
  ],
  json: [
    // "error": "message"  |  "message": "msg"
    /"(?:error|message|reason|failure)"\s*:\s*"([^"]+)"/g
  ]
};

// ============================================================
// FILE WALKER
// ============================================================
function walk(dir, files, depth) {
  files = files || [];
  depth = depth || 0;
  if (depth > 20) return files; // guard against symlink loops

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    if (entry.startsWith('.') && entry !== '.env' && entry !== '.env.example' && entry !== '.env.local') continue;

    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }

    if (stat.isDirectory()) {
      walk(full, files, depth + 1);
    } else if (stat.isFile()) {
      // Skip files larger than 2 MB
      if (stat.size > 2 * 1024 * 1024) continue;

      const ext = path.extname(entry).toLowerCase();
      const lower = entry.toLowerCase();

      // Special-case for dotenv files
      const isEnvFile = lower === '.env' || lower === '.env.example' || lower === '.env.local';

      if (EXT_LANG[ext] || isEnvFile) {
        files.push(full);
      }
    }
  }
  return files;
}

// ============================================================
// EXTRACT
// ============================================================
function firstCapture(match) {
  for (let i = 1; i < match.length; i++) {
    if (match[i]) return match[i];
  }
  return null;
}

function indexFile(file, index) {
  const ext = path.extname(file).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang) return 0;

  const relPath = path.relative(process.cwd(), file);
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    return 0;
  }
  if (!content || content.length < 10) return 0;

  let count = 0;

  // ----- Jupyter notebook: extract Python source from code cells -----
  if (lang === 'notebook') {
    try {
      const nb = JSON.parse(content);
      const cells = (nb.cells || []).filter(c => c.cell_type === 'code');
      cells.forEach((cell, idx) => {
        const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        if (!src) return;
        for (const re of PATTERNS.python) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(src)) !== null) {
            const msg = firstCapture(m);
            if (!msg || msg.trim().length < 3) continue;
            index.push({
              type: 'notebook-error',
              text: msg.trim(),
              file: relPath,
              line: idx + 1,
              context: src.slice(0, 500)
            });
            count++;
          }
        }
      });
    } catch (e) {
      // Not valid JSON — skip
    }
    return count;
  }

  // ----- Regular text file -----
  const lines = content.split('\n');
  const patterns = PATTERNS[lang] || [];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const msg = firstCapture(m);
      if (!msg || msg.trim().length < 3) continue;

      const lineNum = content.substring(0, m.index).split('\n').length;
      const start = Math.max(0, lineNum - 3);
      const end = Math.min(lines.length, lineNum + 2);

      // Type classification by language
      let type = 'code';
      if (['java', 'kotlin', 'groovy', 'scala'].includes(lang)) type = 'java-error';
      else if (lang === 'python') type = 'python-error';
      else if (lang === 'sql') type = 'sql-error';
      else if (['yaml', 'properties', 'json'].includes(lang)) type = 'config-error';
      else if (lang === 'js' || lang === 'ts') type = 'error';

      index.push({
        type: type,
        text: msg.trim(),
        file: relPath,
        line: lineNum,
        context: lines.slice(start, end).join('\n')
      });
      count++;
    }
  }

  return count;
}

// ============================================================
// PLAYWRIGHT TEST RESULTS
// ============================================================
function indexTestResults(index) {
  if (!fs.existsSync(TEST_RESULTS)) {
    return { count: 0, files: 0 };
  }

  let results;
  try {
    results = JSON.parse(fs.readFileSync(TEST_RESULTS, 'utf-8'));
  } catch (e) {
    console.warn('  ↳ test-results.json is not valid JSON, skipping');
    return { count: 0, files: 0 };
  }

  let count = 0;
  let files = new Set();

  function walkSuites(suite, inheritedFile) {
    const filePath = suite.file || inheritedFile;

    for (const spec of suite.specs || []) {
      const specFile = spec.file || filePath;
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          if (!result.error) continue;

          index.push({
            type: 'test-failure',
            text: result.error.message || 'Unknown error',
            file: specFile,
            line: (test.location && test.location.line) || 0,
            context: (result.error.stack || result.error.message || '').slice(0, 800),
            testTitle: spec.title,
            status: result.status
          });
          count++;
          if (specFile) files.add(specFile);
        }
      }
    }

    for (const child of suite.suites || []) {
      walkSuites(child, filePath);
    }
  }

  for (const suite of results.suites || []) {
    walkSuites(suite);
  }

  return { count: count, files: files.size };
}

// ============================================================
// MAIN
// ============================================================
function main() {
  const t0 = Date.now();
  console.log('🔍 ERplorer — building multi-language index...');
  console.log('   Scan root: ' + path.resolve(ROOT_DIR));
  console.log('   Output:    ' + path.resolve(OUTPUT));

  const files = walk(ROOT_DIR, []);
  console.log('   Scanned:   ' + files.length + ' candidate files');

  const index = [];
  const byLang = {};

  for (const file of files) {
    const n = indexFile(file, index);
    if (n > 0) {
      const ext = path.extname(file).toLowerCase();
      byLang[ext] = (byLang[ext] || 0) + n;
      if (VERBOSE) console.log('     ' + path.relative(process.cwd(), file) + ' → ' + n);
    }
  }

  const testResult = indexTestResults(index);

  // ---- Report ----
  console.log('   By file type:');
  const sorted = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
  for (const entry of sorted) {
    console.log('     ' + entry[0].padEnd(14) + entry[1]);
  }
  if (testResult.count > 0) {
    console.log('     playwright   ' + testResult.count + ' (across ' + testResult.files + ' files)');
  }

  // Type breakdown
  const typeCounts = {};
  for (const doc of index) {
    const t = doc.type || 'code';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  console.log('   By category:');
  for (const entry of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log('     ' + entry[0].padEnd(14) + entry[1]);
  }

  // ---- Write ----
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  try {
    fs.writeFileSync(OUTPUT, JSON.stringify(index, null, 2));
  } catch (e) {
    console.error('❌ Failed to write ' + OUTPUT + ': ' + e.message);
    process.exit(1);
  }

  console.log('');
  console.log('✅ Wrote ' + index.length + ' entries to ' + OUTPUT + ' in ' + elapsed + 's');
}

main();