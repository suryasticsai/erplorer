
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

```
git clone https://github.com/suryasticsai/erplorer.git
cd erplorer

# Open the app — no build step
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux
```

3. Optional: start the local runner

If you want real Playwright execution and real HTTP requests (not just spec generation):

```
cd erplorer-runner
npm install
npm run install-browsers   # one-time Chromium download
npm start                  # http://localhost:8787
```

Then in the ERplorer Settings tab, check the Runner card — it should say "✓ Connected."

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Features

🔍 Search

Paste an error message, stack trace line, or SQL keyword. ERplorer finds the file, line number, and surrounding 5 lines of code across your entire indexed codebase.

🧬 Error DNA

Similar errors are clustered using fingerprinting — UUIDs, dates, strings, and numbers are normalized. Instead of scrolling 47 near-duplicates, you see one card with a 🧬 ×47 badge.

💥 Blast Radius

For any error, ERplorer extracts identifiers and shows every other file that references the same names. Instant impact analysis, zero configuration.

🔧 Fix Recipe

16 curated rules for common JavaScript, Java, Python, and SQL errors. Deterministic suggestions, not AI guesswork.

📋 Copy Bug Report

One click turns any result into a formatted Markdown bug report — file:line, error message, code context, and a suggested fix. Paste straight into Jira, Linear, or Slack.

💬 Ask

Natural language over the local error catalog. Matches stay on-device; only the top hits go to the model for a short briefing. Falls back gracefully to a chat-style list if AI is unavailable.

🧪 Test Cases → Code

Describe a flow in English, or drop a spreadsheet. ERplorer emits Playwright specs (for UI + API) and PySpark pytest files (for data validation). Uses AI with a deterministic rules parser as fallback.

📄 PDF Reports

Export search results or session data to a styled PDF — for tickets, standup, or management review.

📷 OCR + Screenshots

Paste or drop an error screenshot. Tesseract.js extracts the text locally and indexes it. Screenshot any result with html2canvas.

🔗 Share Links

Every search is URL-encoded. Copy the link, send it to a teammate, and they open the exact same results.

▶ Real browser runs (optional)

With the local runner, ERplorer can drive a real Chromium instance via Playwright — recording WebM video, capturing per-step screenshots, and logging everything into a queryable session.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Runner

The browser app is intentionally static — it can't spawn a Chromium process or make arbitrary cross-origin requests without CORS. The runner is an optional local Node service that fills both gaps.

What it does

Capability In browser In runner
Generate Playwright specs ✅ ✅
Execute Playwright specs ❌ ✅
Record video of the run ❌ ✅
Capture per-step screenshots ❌ ✅
Make CORS-blocked HTTP calls ❌ ✅
Postman-style chained requests ❌ ✅
Queryable session log + RAG ❌ ✅

Setup

```
cd erplorer-runner
npm install
npm run install-browsers   # downloads Chromium for Playwright, one-time
npm start                  # listens on http://localhost:8787
```

Endpoints

Method Path Purpose
POST /session/start Begin a new session
POST /session/:id/ui-run Execute UI steps via Playwright
POST /session/:id/api-run Execute a Postman-style collection
POST /session/:id/finish Mark the session complete
POST /session/:id/promote Keep beyond TTL (default 72h)
POST /session/:id/ask Ask a question scoped to that session
GET /session/:id Full session JSON
GET /session/:id/flow.md Human-readable flow doc
GET /session/:id/video WebM recording
GET /sessions List all sessions
GET /health Health check

How it stays temporary

Sessions are deleted after 72 hours by default. A janitor runs on boot and every 6 hours. Call /session/:id/promote on any session you want to keep permanently.

How the browser talks to it

erplorer-runner-client.js (loaded after erplorer.js) reads window.ERPLORER_CONFIG.runner.baseUrl and exposes window.ERplorerRunner with:

```
ERplorerRunner.isAvailable()        // bool
ERplorerRunner.startSession(opts)   // { sessionId, meta }
ERplorerRunner.runUiSteps(steps)    // { ok, stepCount, errorCount, videoFile }
ERplorerRunner.runApiCollection(c, v)  // { ok, passCount, failCount }
ERplorerRunner.finishSession()
ERplorerRunner.askSession(question) // { answer, chunksUsed }
ERplorerRunner.getVideoUrl()        // URL or null
ERplorerRunner.getFlowUrl()         // URL or null
```

If the runner isn't running, every call returns { ok: false, reason: 'offline' } and the browser app silently degrades to spec-generation-only mode.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  ERplorer (static, in browser)              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Search       │  │ Ask (chat)   │  │ Lab (test cases) │  │
│  │              │  │              │  │                  │  │
│  │ FlexSearch   │  │ Local + AI   │  │ AI → specs       │  │
│  │ Error DNA    │  │              │  │ Rules fallback   │  │
│  │ Fix Recipe   │  │              │  │                  │  │
│  │ Blast Radius │  │              │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Ingest (5)   │  │ OCR          │  │ PDF + Screenshot │  │
│  │              │  │              │  │                  │  │
│  │ URL / repo   │  │ Tesseract.js │  │ jsPDF            │  │
│  │ files/paste  │  │              │  │ html2canvas      │  │
│  │ screenshot   │  │              │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ (optional — only when running)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              erplorer-runner (Node, localhost)              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Playwright   │  │ HTTP engine  │  │ Session store    │  │
│  │              │  │              │  │                  │  │
│  │ Chromium     │  │ Postman-like │  │ JSON + flow.md   │  │
│  │ WebM video   │  │ {{vars}}     │  │ + screenshots    │  │
│  │ screenshots  │  │ extract      │  │ + WebM           │  │
│  │ console log  │  │ assertions   │  │ (72h TTL)        │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

<p align="right"><a href="#top">↑ Back to top</a></p>

---

File structure

```
erplorer/
├── index.html                    ← markup only
├── style.css                     ← all styles
├── erplorer.config.js            ← endpoints, webhooks, runner, MCP, feature flags
├── erplorer.js                   ← main app (all browser logic)
├── erplorer-runner-client.js     ← bridge to the local runner
├── search-index.json             ← generated by CI, read by the app
├── erplorer-logo.png
├── LICENSE
├── README.md
│
├── scripts/
│   └── build-index.js            ← scans repo, writes search-index.json
│
├── src/                          ← your app source (indexed by build-index.js)
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

Configuration

Everything lives in erplorer.config.js. Edit that one file to change how the whole app behaves.

Endpoints

Point at your own AI or crawl endpoints:

```
endpoints: {
  aiPrimary:  'https://your-vercel.app/api/ask',
  aiFallback: 'https://text.pollinations.ai/openai',
  crawl:      'https://your-vercel.app/api/crawl'
}
```

Runner

```
runner: {
  baseUrl: 'http://localhost:8787'
}
```

Feature flags

Disable anything you don't want — the UI hides those features automatically:

```
features: {
  errorDNA: true,
  fixRecipe: true,
  blastRadius: true,
  screenshot: true,
  pdfReport: true,
  ocr: true,
  chat: true,
  shareLink: true,
  bugReport: true,
  runner: true
}
```

Webhooks

Fire events to Slack, Teams, Discord, or a custom endpoint:

```
webhooks: {
  slack: {
    enabled: true,
    url: 'https://hooks.slack.com/services/...',
    channel: '#qa',
    events: ['bug.created', 'session.complete']
  }
}
```

Available events: bug.created, session.complete, search.copied, index.updated.

MCP

Point at a Model Context Protocol server to expose ERplorer search as tools:

```
mcp: {
  enabled: true,
  serverUrl: 'http://localhost:3000/mcp',
  name: 'erplorer',
  tools: ['search', 'get_result', 'list_patterns', 'run_session']
}
```

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Usage

Search tab

Type an error message or keyword. Results show file, line, and code with the matched text highlighted. Use the chips to filter by type.

Ask tab

Chat-style natural language over the index. Quick prompts at the top for common questions. Falls back to a list of matches if AI is unreachable.

Lab tab

Two sub-tabs:

· Scenarios — paste English test steps. Convert with AI or rules. Edit the table inline. Generate Playwright + pytest specs.
· Specs — drop an Excel/CSV of test cases. Get generated files to download.

Ingest tab

Five ways to grow the index:

1. URL — the RAGina crawler fetches up to 20 pages
2. GitHub repo — enter owner/repo, public repos need no token
3. Files — drop .js .ts .java .py .sql .yaml .json .ipynb
4. Paste — any stack trace, log, or file content
5. Screenshot — Tesseract.js extracts text from images locally

About tab

Everything about the tool, its USPs, and the person who built it.

Settings tab

Theme, GitHub token, runner status, config view, AI endpoint health.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Indexed file types

Extension Language Extracted
.js .ts .jsx .tsx .mjs Node.js throw new Error, console.error
.java .kt .groovy .scala JVM throw new XxxException, logger.error
.py Python raise, dbutils.notebook.exit, logger.error
.ipynb Databricks notebooks Python cells only
.sql Databricks SQL RAISE EXCEPTION, error codes
.yaml .yml .properties .json Config error:, message: keys

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Tech stack

Layer Tool Link
Full-text search FlexSearch nextapps-de/flexsearch
Excel / CSV parsing SheetJS sheetjs.com
GitHub API Octokit octokit/octokit.js
OCR Tesseract.js naptha/tesseract.js
Screenshot html2canvas niklasvh/html2canvas
PDF generation jsPDF parallax/jsPDF
Browser automation (runner) Playwright microsoft/playwright
HTTP server (runner) Express expressjs/express
AI assistant RAGina suryasticsai/RAGina

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Local development

No build step. No bundler. No npm install for the browser app.

```
# Clone
git clone https://github.com/suryasticsai/erplorer.git
cd erplorer

# Edit files, then just refresh the browser
open index.html

# Rebuild the search index locally
node scripts/build-index.js

# Or serve on a local port if you need CORS
npx serve .
```

The browser app is one HTML file, one CSS file, and three JavaScript files. Change any of them, refresh, done.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

Contributing

1. Fork the repo: github.com/suryasticsai/erplorer/fork
2. Create a feature branch
3. Commit your changes
4. Open a pull request: github.com/suryasticsai/erplorer/compare
5. Report bugs: github.com/suryasticsai/erplorer/issues

<p align="right"><a href="#top">↑ Back to top</a></p>

---

License

Apache 2.0 — see LICENSE for details.

<p align="right"><a href="#top">↑ Back to top</a></p>

---

<p align="center">
  <a href="https://suryasticsai.github.io/erplorer/"><strong>🚀 Try ERplorer now</strong></a>
</p>

<p align="center">
  <sub>Built by <a href="https://linkedin.com/in/suryasticsai">Varakala Sai (Surya)</a> · Techno Agilist · Dev Engineer · Strategic Consultant</sub>
</p>
```

---

🎯 What's inside this README

Logo header — the 200px logo sits at the very top with the app name and tagline centered below it.

Two large badges — Live Demo and GitHub repo, right below the tagline. These are the first thing visitors click.

Top navigation bar — a horizontal list of anchor links that jumps to any section. Sits between two --- dividers so it reads as a real nav bar.

Back-to-top links — after every major section, there's a small <p align="right"><a href="#top">↑ Back to top</a></p>. The <a name="top"></a> anchor at the very top of the file makes these work.

Table of contents — the top nav is the table of contents, but each section is also linked from the Quick Start onward.

Runner section — new. Explains what the runner does, how to start it, what endpoints exist, how the client talks to it, and how the temporary session storage works.

Architecture diagram — an ASCII diagram showing the browser app and the runner as two independent layers.

File structure — reflects the current state of the repo, including the runner folder.

Configuration section — walks through every block in erplorer.config.js with copy-paste examples.

Indexed file types — the same table from before, still accurate.

Tech stack — updated with Playwright, Express, Tesseract.js, html2canvas, jsPDF.

Footer — a call to action and a signature line with your name, title, and LinkedIn.

---

⚠️ One thing to verify

The logo URL at the top uses the raw GitHub path:

```
https://raw.githubusercontent.com/suryasticsai/erplorer/main/erplorer-logo.png
```

If your default branch is not main (e.g., it's master), change that segment. To confirm, open the raw URL directly in a browser — if the image loads, the path is right.

Optional upgrade: use jsDelivr for faster global caching:

```
https://cdn.jsdelivr.net/gh/suryasticsai/erplorer@main/erplorer-logo.png
```

Both work. jsDelivr is noticeably faster on first load for anyone outside your region.

Commit this README and the back-to-top links will work immediately on GitHub.