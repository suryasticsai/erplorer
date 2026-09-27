<a name="top"></a>

<p align="center">
  <img src="https://raw.githubusercontent.com/suryasticsai/erplorer/main/erplorer-logo.png" alt="ERplorer" width="200">
</p>

<h1 align="center">ERplorer</h1>

<p align="center">
  <strong>Error Resolution Explorer</strong><br>
  From stack trace to source line — for Java, Node.js, Databricks, and configs.
</p>

<p align="center">
  <a href="https://suryasticsai.github.io/erplorer/"><img src="https://img.shields.io/badge/🚀_Live_Demo-Open_ERplorer-1E40AF?style=for-the-badge" alt="Live Demo"></a>
  <a href="https://github.com/suryasticsai/erplorer"><img src="https://img.shields.io/badge/📦_GitHub-erplorer-181717?style=for-the-badge&logo=github" alt="GitHub"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/vanilla-JS-F7DF1E?style=flat-square" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/build-none-1E40AF?style=flat-square" alt="No build step">
  <img src="https://img.shields.io/badge/runner-node_18+-68A063?style=flat-square&logo=node.js" alt="Node runner">
  <img src="https://img.shields.io/badge/playwright-optional-2EAD33?style=flat-square&logo=playwright" alt="Playwright">
  <img src="https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square" alt="Apache 2.0">
</p>

---

<p align="center">
  <a href="#what-it-does">What it does</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#runner">Runner</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#file-structure">File structure</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#tech-stack">Tech stack</a> ·
  <a href="#license">License</a>
</p>

---

## What it does

ERplorer indexes your codebase — Java, Node.js, Python, SQL, YAML, JSON, Databricks notebooks — and lets anyone search it by pasting an error message. It returns the exact **file**, **line number**, and **surrounding code**.

Built for QA teams. Runs entirely in the browser. Zero build, zero cost, zero infrastructure.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Quick start

Two ways to use it:

### 1. Use the hosted app (nothing to install)

👉 **[Open ERplorer](https://suryasticsai.github.io/erplorer/)**

Paste an error, SQL keyword, or stack trace into the search box. You'll get file, line, and context instantly.

### 2. Run it locally

```bash
git clone https://github.com/suryasticsai/erplorer.git
cd erplorer

# Open the app — no build step
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux
```

### 3. Optional: start the local runner

If you want real Playwright execution and real HTTP requests (not just spec generation):

```bash
cd erplorer-runner
npm install
npm run install-browsers   # one-time Chromium download
npm start                  # http://localhost:8787
```

The Lab tab shows a **"▶ Run via Runner"** button next to "Generate specs" once the runner is reachable. If it's offline, the button says so and the rest of the app works exactly as before.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Features

**🔍 Search**
Paste an error message, stack trace line, or SQL keyword. ERplorer finds the file, line number, and surrounding lines of code across your entire indexed codebase.

**🧬 Error DNA**
Similar errors are clustered using fingerprinting — UUIDs, dates, strings, and numbers are normalized. Instead of scrolling 47 near-duplicates, you see one card with a 🧬 ×47 badge.

**💥 Blast Radius**
For any error, ERplorer extracts identifiers and shows every other file that references the same names. Instant impact analysis, zero configuration.

**🔧 Fix Recipe**
16 curated rules for common JavaScript, Java, Python, and SQL errors. Deterministic suggestions, not AI guesswork.

**📋 Copy Bug Report**
One click turns any result into a formatted Markdown bug report — file:line, error message, code context, and a suggested fix. Paste straight into Jira, Linear, or Slack.

**💬 Ask**
Natural language over the local error catalog. Matches stay on-device; only the top hits go to the model for a short briefing. Falls back to a plain match list if AI is unreachable.

**🧪 Test Cases → Code**
Describe a flow in English, or drop a spreadsheet. ERplorer emits Playwright specs (UI + API) and PySpark pytest files (data validation). Uses AI with a deterministic rules parser as fallback.

**📄 PDF Reports**
Export search results to a styled PDF — for tickets, standup, or management review.

**📷 OCR + Screenshots**
Paste or drop an error screenshot. Tesseract.js extracts the text locally and indexes it. Screenshot any result with html2canvas.

**🔗 Share Links**
Every search is URL-encoded. Copy the link, send it to a teammate, and they open the exact same results.

**▶ Real browser runs (optional, via runner)**
With the local runner, ERplorer can drive a real Chromium instance via Playwright — recording WebM video, capturing per-step screenshots, and logging everything into a queryable session.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Runner

The browser app is intentionally static — it can't spawn a Chromium process or make arbitrary cross-origin requests. `erplorer-runner` is an optional local Node service that fills both gaps.

| Capability | In browser | In runner |
|---|---|---|
| Generate Playwright/pytest specs | ✅ | ✅ |
| Execute Playwright specs | ❌ | ✅ |
| Record video of the run (WebM) | ❌ | ✅ |
| Capture per-step screenshots | ❌ | ✅ |
| Make CORS-blocked HTTP calls | ❌ | ✅ |
| Postman-style chained requests | ❌ | ✅ |
| Queryable session log + RAG | ❌ | ✅ |

### Setup

```bash
cd erplorer-runner
npm install
npm run install-browsers   # downloads Chromium for Playwright, one-time
npm start                  # listens on http://localhost:8787
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/session/start` | Begin a new session |
| POST | `/session/:id/ui-run` | Execute UI steps via Playwright |
| POST | `/session/:id/api-run` | Execute a Postman-style collection |
| POST | `/session/:id/finish` | Mark the session complete |
| POST | `/session/:id/promote` | Keep beyond TTL (default 72h) |
| POST | `/session/:id/ask` | Ask a question scoped to that session |
| GET | `/session/:id` | Full session JSON |
| GET | `/session/:id/flow.md` | Human-readable flow doc |
| GET | `/session/:id/video` | WebM recording |
| GET | `/sessions` | List all sessions |
| GET | `/health` | Health check |

### How it stays temporary

Sessions are deleted after 72 hours by default. A janitor sweep runs on boot and every 6 hours. Call `POST /session/:id/promote` on any session you want to keep permanently.

### How the browser talks to it

`erplorer-runner-client.js` (loaded after `erplorer.js`) reads `window.ERPLORER_CONFIG.runner.baseUrl`, silently disables itself if that's unset or the runner is unreachable, and exposes `window.ERplorerRunner`:

```js
ERplorerRunner.checkHealth()              // async -> bool, refreshes runner availability
ERplorerRunner.runCurrentRowsViaRunner()  // starts a session from the Lab tab's
                                           // current generated rows, runs the UI
                                           // steps + API collection, and renders
                                           // a video link / flow-doc link / ask
                                           // box directly into the Lab panel
ERplorerRunner.promoteSession(sessionId)  // async -> keeps that session past its TTL
ERplorerRunner.baseUrl                    // the configured runner URL
```

In practice you don't call these directly — the client injects a **"▶ Run via Runner"** button next to the Lab tab's "Generate specs" button, and that button drives the whole flow (start session → run UI steps → run API steps → finish → show video/flow-doc links + an inline "ask this session" box).

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  ERplorer (static, in browser)               │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Search       │  │ Ask (chat)   │  │ Lab (test cases) │   │
│  │              │  │              │  │                  │   │
│  │ FlexSearch   │  │ Local + AI   │  │ AI → specs       │   │
│  │ Error DNA    │  │              │  │ Rules fallback   │   │
│  │ Fix Recipe   │  │              │  │ "Run via Runner" │   │
│  │ Blast Radius │  │              │  │                  │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Ingest (5)   │  │ OCR          │  │ PDF + Screenshot │   │
│  │              │  │              │  │                  │   │
│  │ URL / repo   │  │ Tesseract.js │  │ jsPDF            │   │
│  │ files/paste  │  │              │  │ html2canvas      │   │
│  │ screenshot   │  │              │  │                  │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ erplorer-runner-client.js
                            │ (optional — only active when the
                            │  runner is reachable)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              erplorer-runner (Node, localhost)                │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Playwright   │  │ HTTP engine  │  │ Session store    │   │
│  │              │  │              │  │                  │   │
│  │ Chromium     │  │ Postman-like │  │ JSON + flow.md   │   │
│  │ WebM video   │  │ {{vars}}     │  │ + screenshots    │   │
│  │ screenshots  │  │ extract      │  │ + WebM           │   │
│  │ console log  │  │ assertions   │  │ (72h TTL)        │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## File structure

```
erplorer/
├── index.html                    ← markup only
├── style.css                     ← all styles
├── erplorer.config.js            ← endpoints, webhooks, runner, MCP, feature flags
├── erplorer.js                   ← main app (all browser logic)
├── erplorer-runner-client.js     ← bridge to the local runner
├── erplorer-logo.png
├── LICENSE
├── README.md
│
└── erplorer-runner/              ← optional local Node service
    ├── .gitignore
    ├── package.json
    ├── server.js                 ← Express HTTP layer
    ├── sessions/
    │   └── .gitkeep
    └── lib/
        ├── api.js                ← Postman-style request engine
        ├── browser.js            ← Playwright UI runner
        ├── rag.js                ← session-scoped RAG
        └── session.js            ← session lifecycle + janitor
```

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Configuration

Everything the browser app needs lives in `erplorer.config.js`.

### Endpoints

```js
endpoints: {
  aiPrimary:  'https://your-vercel.app/api/ask',
  aiFallback: 'https://text.pollinations.ai/openai',
  crawl:      'https://your-vercel.app/api/crawl'
}
```

### Runner

```js
runner: {
  baseUrl: 'http://localhost:8787'
}
```

Leave this block out entirely to keep the app runner-free — `erplorer-runner-client.js` no-ops if it's missing.

### Feature flags

```js
features: {
  errorDNA: true,
  fixRecipe: true,
  blastRadius: true,
  screenshot: true,
  pdfReport: true,
  ocr: true,
  chat: true,
  shareLink: true,
  bugReport: true
}
```

### Webhooks

```js
webhooks: {
  slack: {
    enabled: true,
    url: 'https://hooks.slack.com/services/...',
    channel: '#qa',
    events: ['bug.created', 'index.updated']
  }
}
```

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Usage

**Search tab** — type an error message or keyword. Results show file, line, and code with matched text highlighted. Use the chips to filter by type.

**Ask tab** — chat-style natural language over the index. Falls back to a list of matches if AI is unreachable.

**Lab tab** — two sub-tabs:
- *Scenarios* — paste English test steps, convert with AI or rules, edit the table inline, generate Playwright + pytest specs, optionally run them for real via the runner.
- *Specs* — drop an Excel/CSV of test cases and get generated spec files to download.

**Ingest tab** — five ways to grow the index: URL crawl, GitHub repo scan, file drop, paste, or screenshot OCR.

**About tab** — the tool's USPs and who built it.

**Settings tab** — theme, GitHub token, config view, AI endpoint health.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Indexed file types

| Extension | Language | Extracted |
|---|---|---|
| `.js` `.ts` `.jsx` `.tsx` `.mjs` | Node.js | `throw new Error`, `console.error` |
| `.java` `.kt` `.groovy` `.scala` | JVM | `throw new XxxException`, `logger.error` |
| `.py` | Python | `raise`, `dbutils.notebook.exit`, `logger.error` |
| `.sql` | Databricks SQL | `RAISE EXCEPTION`, error codes |
| `.yaml` `.yml` `.properties` `.json` | Config | `error:`, `message:` keys |

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Tech stack

| Layer | Tool |
|---|---|
| Full-text search | [FlexSearch](https://github.com/nextapps-de/flexsearch) |
| Excel / CSV parsing | [SheetJS](https://sheetjs.com) |
| GitHub API | [Octokit](https://github.com/octokit/octokit.js) |
| OCR | [Tesseract.js](https://github.com/naptha/tesseract.js) |
| Screenshot | [html2canvas](https://github.com/niklasvh/html2canvas) |
| PDF generation | [jsPDF](https://github.com/parallax/jsPDF) |
| Browser automation (runner) | [Playwright](https://github.com/microsoft/playwright) |
| HTTP server (runner) | [Express](https://github.com/expressjs/express) |

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Local development

No build step, no bundler, no npm install for the browser app itself.

```bash
git clone https://github.com/suryasticsai/erplorer.git
cd erplorer
open index.html
```

The browser app is one HTML file, one CSS file, and two JavaScript files (`erplorer.js`, `erplorer-runner-client.js`). Change any of them, refresh, done.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## Contributing

1. Fork the repo: `github.com/suryasticsai/erplorer/fork`
2. Create a feature branch
3. Commit your changes
4. Open a pull request: `github.com/suryasticsai/erplorer/compare`
5. Report bugs: `github.com/suryasticsai/erplorer/issues`

<p align="right"><a href="#top">↑ Back to top</a></p>

---

## License

Apache 2.0 — see LICENSE for details.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

<p align="center">
  <a href="https://suryasticsai.github.io/erplorer/"><strong>🚀 Try ERplorer now</strong></a>
</p>

<p align="center">
  <sub>Built by <a href="https://linkedin.com/in/suryasticsai">Varakala Sai (Surya)</a> · Techno Agilist · Dev Engineer · Strategic Consultant</sub>
</p>
