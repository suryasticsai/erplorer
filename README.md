
<p align="center">
  <img src="https://raw.githubusercontent.com/suryasticsai/erplorer/main/erplorer-logo.png" alt="ERplorer" width="180">
</p>

<h1 align="center">ERplorer</h1>

<p align="center">
  <strong>Error Resolution Explorer</strong><br>
  From error message to source line — for Java, Node.js, Databricks, and configs.
</p>

<p align="center">
  <a href="https://suryasticsai.github.io/erplorer/"><img src="https://img.shields.io/badge/🚀_Live_Demo-Open_ERplorer-F59E0B?style=for-the-badge" alt="Live Demo"></a>
  <a href="https://github.com/suryasticsai/erplorer"><img src="https://img.shields.io/badge/📦_GitHub-erplorer-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/vanilla-JS-F7DF1E?style=flat-square" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/build-none-3B82F6?style=flat-square" alt="No build step">
  <img src="https://img.shields.io/badge/AI-Consoleena-8B5CF6?style=flat-square" alt="Consoleena">
  <img src="https://img.shields.io/badge/license-MIT-22C55E?style=flat-square" alt="MIT">
</p>

## What it does

ERplorer indexes your codebase — Java, Node.js, Python, SQL, YAML, JSON, Databricks notebooks — and lets anyone search it by pasting an error message. It returns the exact **file**, **line number**, and **surrounding code**.

Built for QA teams. Runs entirely in the browser. Zero cost, zero servers.

👉 **[Open ERplorer →](https://suryasticsai.github.io/erplorer/)**

## Features

- 🔍 **Paste an error → get file:line** — instant search across all languages
- 💬 **Ask AI** — natural language queries powered by [Consoleena](https://github.com/suryasticsai/Consoleena)
- 📊 **Test Cases → Code** — drop an Excel/CSV of test cases, get runnable Playwright or pytest specs
- 🧪 **Multi-language indexing** — Java, JS/TS, Python, SQL, YAML, JSON, `.ipynb`
- ➕ **Add content on the fly** — 4 tiers: crawl a URL, scan a GitHub repo, drop a folder, or paste text
- 🔐 **Optional GitHub API** — live queries against private repos
- 🎨 **Zero build step** — one HTML file, CDN libraries, works from `file://`

## Quick start

1. Open **[https://suryasticsai.github.io/erplorer/](https://suryasticsai.github.io/erplorer/)**
2. Paste an error message or click **Ask AI**
3. Read the file:line result

## Add Content — 4 tiers

| Tier | What it does | When to use |
|---|---|---|
| **1. Crawl URL** | Crawls a docs site or hosted app | You want to index external content |
| **2. GitHub repo** | Scans any repo via [Octokit](https://github.com/octokit/octokit.js) | You want to index another repo |
| **3. Folder / Files** | Reads local folders via File System API | You have files on disk |
| **4. Paste text** | Always works — pure client-side | Everything else failed |

## Test case types

The **Test Cases → Code** tab accepts a spreadsheet with these columns:

| Column | Purpose |
|---|---|
| `id` | Test case ID (e.g. `TC001`) |
| `scenario` | Human-readable name |
| `step` | Step number |
| `action` | One of the actions below |
| `method` `url` `headers` `body` | API test fields |
| `selector` `value` `expected` `jsonpath` | UI and assertion fields |

### Supported actions

**🧪 UI ([Playwright](https://playwright.dev/)):** `goto`, `fill`, `click`, `expectText`, `expectVisible`, `expectUrl`, `wait`

**🔌 API (Playwright request):** `apiRequest`, `expectStatus`, `expectJson`, `expectHeader`

**📊 Data ([pytest](https://pytest.org/) + [PySpark](https://spark.apache.org/docs/latest/api/python/)):** `runSql`, `expectRowCount`, `expectNoNulls`, `expectUnique`, `expectValue`

## Indexed file types

| Extension | Language | Extracted |
|---|---|---|
| `.js` `.ts` `.jsx` `.tsx` `.mjs` | Node.js | `throw new Error`, `console.error` |
| `.java` `.kt` `.groovy` `.scala` | JVM | `throw new XxxException`, `logger.error` |
| `.py` | Python | `raise`, `dbutils.notebook.exit`, `logger.error` |
| `.ipynb` | Databricks notebooks | Python cells only |
| `.sql` | Databricks SQL | `RAISE EXCEPTION`, error codes |
| `.yaml` `.yml` `.properties` `.json` | Config | `error:`, `message:` keys |

## Architecture

```

┌─────────────────────────────────────────┐
│          Browser (GitHub Pages)          │
│                                          │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │Error Explorer│  │Test Cases → Code │ │
│  │  FlexSearch  │  │ Excel / CSV      │ │
│  │  +Consoleena │  │ → Playwright     │ │
│  │              │  │ → pytest         │ │
│  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────┘
▲
│ search-index.json
│
┌─────────────────────────────────────────┐
│         GitHub Actions (CI)              │
│                                          │
│  scripts/build-index.js scans:          │
│   • .java .kt .groovy .scala            │
│   • .js .ts .jsx .tsx                   │
│   • .py .ipynb                          │
│   • .sql .yaml .json .properties        │
└─────────────────────────────────────────┘

```

## Tech stack

| Layer | Tool | Link |
|---|---|---|
| Full-text search | FlexSearch | [nextapps-de/flexsearch](https://github.com/nextapps-de/flexsearch) |
| Excel / CSV parsing | SheetJS | [sheetjs.com](https://sheetjs.com/) |
| GitHub API | Octokit | [octokit/octokit.js](https://github.com/octokit/octokit.js) |
| AI assistant | Consoleena | [suryasticsai/Consoleena](https://github.com/suryasticsai/Consoleena) |
| Crawler backend | RAGina | [suryasticsai/RAGina](https://github.com/suryasticsai/RAGina) |
| Hosting | GitHub Pages | [pages.github.com](https://pages.github.com/) |

## Local development

```bash
# Clone
git clone https://github.com/suryasticsai/erplorer.git
cd erplorer

# Open the tool — no build step
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux
```

To rebuild the search index locally:

```bash
node scripts/build-index.js
```

Contributing

1. Fork the repo: github.com/suryasticsai/erplorer/fork
2. Create a feature branch
3. Commit your changes
4. Open a pull request: github.com/suryasticsai/erplorer/compare
5. Report bugs: github.com/suryasticsai/erplorer/issues

License

MIT — see LICENSE for details.

<p align="center">
  <a href="https://suryasticsai.github.io/erplorer/"><strong>🚀 Try ERplorer now</strong></a>
</p>
```

 