#!/usr/bin/env node
/**
 * ERplorer multi-language index builder.
 * Scans Java, Node.js, Python, SQL, YAML, JSON, properties, and notebooks.
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.env.ERPLORER_SCAN || '.';
const TEST_RESULTS = './test-results.json';
const OUTPUT = './search-index.json';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'out',
  '.next', '.cache', 'coverage', 'venv', '.venv', '__pycache__'
]);

const EXT_LANG = {
  '.js':'js', '.mjs':'js', '.cjs':'js', '.jsx':'js',
  '.ts':'ts', '.tsx':'ts',
  '.java':'java', '.kt':'kotlin', '.groovy':'groovy',
  '.py':'python',
  '.sql':'sql',
  '.scala':'scala',
  '.yaml':'yaml', '.yml':'yaml',
  '.json':'json',
  '.properties':'properties', '.env':'properties',
  '.ipynb':'notebook'
};

const PATTERNS = {
  js: [
    /(?:throw new Error|Error\(|console\.error)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
  ],
  ts: [
    /(?:throw new Error|Error\(|console\.error)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
  ],
  java: [
    /throw new \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g,
    /LOG(?:GER)?\.(?:error|warn|severe|log)\s*\(\s*(?:[^,)]+,\s*)?"([^"]+)"/gi,
    /logger\.(?:error|warn|severe|log)\s*\(\s*(?:[^,)]+,\s*)?"([^"]+)"/gi
  ],
  kotlin: [ /throw \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g ],
  groovy: [ /throw new \w*(?:Exception|Error)\s*\(\s*'([^']+)'/g ],
  python: [
    /raise \w+(?:Error|Exception)\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g,
    /dbutils\.notebook\.exit\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g,
    /logger\.(?:error|warning|critical)\s*\(\s*(?:f?'([^']+)'|f?"([^"]+)")/g
  ],
  sql: [
    /RAISE\s+EXCEPTION\s+'([^']+)'/gi,
    /SIGNAL\s+SQLSTATE\s+'[^']*'\s+SET\s+MESSAGE_TEXT\s*=\s*'([^']+)'/gi,
    /\b(INVALID_FORMAT|PATH_NULL|MALFORMED_FILE_REF|TABLE_OR_VIEW_NOT_FOUND|PARSE_SYNTAX_ERROR|UNRESOLVED_COLUMN)\b/g
  ],
  scala: [ /throw new \w*(?:Exception|Error)\s*\(\s*"([^"]+)"/g ],
  yaml: [ /^\s*(?:error|failure|reason|message)\s*:\s*["']?([^"'\n#]+)/gim ],
  properties: [ /^\s*[\w.-]*error[\w.-]*\s*[:=]\s*(.+)$/gim ],
  json: [ /"(?:error|message|reason|failure)"\s*:\s*"([^"]+)"/g ]
};

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) walk(full, files);
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function firstCapture(match) {
  for (let i = 1; i < match.length; i++) if (match[i]) return match[i];
  return null;
}

function indexFile(file, index) {
  const ext = path.extname(file).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang) return 0;

  const relPath = path.relative(process.cwd(), file);
  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }
  if (!content) return 0;

  let count = 0;

  if (lang === 'notebook') {
    try {
      const nb = JSON.parse(content);
      const cells = (nb.cells || []).filter(c => c.cell_type === 'code');
      cells.forEach((cell, idx) => {
        const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
        PATTERNS.python.forEach(re => {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(src)) !== null) {
            const message = firstCapture(m);
            if (!message) continue;
            index.push({
              type: 'notebook-error',
              text: message,
              file: relPath,
              line: idx + 1,
              context: src.slice(0, 400)
            });
            count++;
          }
        });
      });
    } catch {}
    return count;
  }

  const lines = content.split('\n');
  const patterns = PATTERNS[lang] || [];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const message = firstCapture(m);
      if (!message || message.trim().length < 3) continue;

      const lineNum = content.substring(0, m.index).split('\n').length;
      const start = Math.max(0, lineNum - 3);
      const end = Math.min(lines.length, lineNum + 2);

      let type = 'code';
      if (['java','kotlin','groovy','scala'].includes(lang)) type = 'java-error';
      else if (lang === 'python') type = 'python-error';
      else if (lang === 'sql') type = 'sql-error';
      else if (['yaml','properties','json'].includes(lang)) type = 'config-error';
      else type = 'error';

      index.push({
        type,
        text: message.trim(),
        file: relPath,
        line: lineNum,
        context: lines.slice(start, end).join('\n')
      });
      count++;
    }
  }

  return count;
}

function indexTestResults(index) {
  if (!fs.existsSync(TEST_RESULTS)) return 0;
  let results;
  try { results = JSON.parse(fs.readFileSync(TEST_RESULTS, 'utf-8')); } catch { return 0; }
  let count = 0;

  function walkSuites(suite, inheritedFile = '') {
    const filePath = suite.file || inheritedFile;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          if (!result.error) continue;
          index.push({
            type: 'test-failure',
            text: result.error.message || 'Unknown error',
            file: spec.file || filePath,
            line: test.location?.line || 0,
            context: (result.error.stack || result.error.message || '').slice(0, 800),
            testTitle: spec.title,
            status: result.status
          });
          count++;
        }
      }
    }
    for (const child of suite.suites || []) walkSuites(child, filePath);
  }
  for (const suite of results.suites || []) walkSuites(suite);
  return count;
}

function main() {
  console.log('🔍 ERplorer — building multi-language index...');
  const files = walk(ROOT_DIR);
  console.log(`  ↳ Scanned ${files.length} files`);

  const index = [];
  const byLang = {};

  for (const file of files) {
    const n = indexFile(file, index);
    if (n > 0) {
      const ext = path.extname(file).toLowerCase();
      byLang[ext] = (byLang[ext] || 0) + n;
    }
  }

  const testCount = indexTestResults(index);

  console.log('  ↳ By file type:');
  Object.entries(byLang).sort((a,b) => b[1]-a[1]).forEach(([ext, n]) => {
    console.log(`     ${ext.padEnd(12)} ${n}`);
  });
  console.log(`  ↳ Test failures: ${testCount}`);
  console.log(`✅ Wrote ${index.length} entries to ${OUTPUT}`);

  fs.writeFileSync(OUTPUT, JSON.stringify(index, null, 2));
}

main();