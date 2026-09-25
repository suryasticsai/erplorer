#!/usr/bin/env node
/**
 * ERplorer index builder.
 * Scans source code + Playwright test results, emits search-index.json.
 */
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = './src';
const TEST_RESULTS = './test-results.json';
const OUTPUT = './search-index.json';

// Matches: throw new Error('...'), Error("..."), console.error(`...`)
const ERROR_REGEX =
  /(?:throw new Error|Error\(|console\.error)\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      walk(full, files);
    } else if (/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

function indexSourceCode(index) {
  const files = walk(SOURCE_DIR);
  let count = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    let match;

    ERROR_REGEX.lastIndex = 0;
    while ((match = ERROR_REGEX.exec(content)) !== null) {
      const message = match[1] || match[2] || match[3];
      if (!message) continue;

      const lineNum = content.substring(0, match.index).split('\n').length;
      const start = Math.max(0, lineNum - 3);
      const end = Math.min(lines.length, lineNum + 2);

      index.push({
        type: 'error',
        text: message,
        file: path.relative(process.cwd(), file),
        line: lineNum,
        context: lines.slice(start, end).join('\n'),
      });
      count++;
    }
  }
  console.log(`  ↳ Indexed ${count} source errors from ${files.length} files`);
}

function indexTestResults(index) {
  if (!fs.existsSync(TEST_RESULTS)) {
    console.log('  ↳ No test-results.json found, skipping.');
    return;
  }

  const results = JSON.parse(fs.readFileSync(TEST_RESULTS, 'utf-8'));
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
            status: result.status,
          });
          count++;
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
  console.log(`  ↳ Indexed ${count} test failures`);
}

function main() {
  console.log('🔍 ERplorer — building index...');
  const index = [];
  indexSourceCode(index);
  indexTestResults(index);

  fs.writeFileSync(OUTPUT, JSON.stringify(index, null, 2));
  console.log(`✅ Wrote ${index.length} entries to ${OUTPUT}`);
}

main();
