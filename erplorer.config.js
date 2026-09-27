/**
 * ERplorer configuration.
 *
 * Edit this file to point at your own endpoints, enable webhooks,
 * wire the local runner, or configure MCP. Everything here is optional —
 * the app falls back to sensible defaults when a value is missing.
 */
window.ERPLORER_CONFIG = {
  version: '1.2.0',
  appName: 'ERplorer',
  tagline: 'Error Resolution Explorer',

  // ---- AI + crawl endpoints ----
  endpoints: {
    aiPrimary:  'https://ragina-crawler-ragina.vercel.app/api/ask',
    aiFallback: 'https://text.pollinations.ai/openai',
    crawl:      'https://ragina-crawler-ragina.vercel.app/api/crawl'
  },

  // ---- Local runner (erplorer-runner) ----
  // The Node companion service that drives Playwright + real HTTP.
  // Start it with: cd erplorer-runner && npm start
  // If it's not running, the app silently degrades to spec-generation-only mode.
  runner: {
    baseUrl: 'http://localhost:8787'
  },

  // ---- Feature flags ----
  features: {
    errorDNA:    true,   // cluster similar errors with ×N badge
    fixRecipe:   true,   // inline fix suggestions
    blastRadius: true,   // cross-file identifier references
    screenshot:  true,   // html2canvas capture on results
    pdfReport:   true,   // jsPDF session report
    ocr:         true,   // Tesseract.js image-to-text
    chat:        true,   // chat-style Ask tab
    shareLink:   true,
    bugReport:   true,
    runner:      true    // enable the local Node runner integration
  },

  // ---- Webhook dispatch ----
  // Fire on events: 'session.complete', 'bug.created', 'search.copied', 'index.updated'
  webhooks: {
    slack: {
      enabled: false,
      url: '',                 // https://hooks.slack.com/services/...
      channel: '#qa',
      events: ['bug.created', 'session.complete']
    },
    teams: {
      enabled: false,
      url: '',                 // https://outlook.office.com/webhook/...
      events: ['session.complete']
    },
    discord: {
      enabled: false,
      url: '',                 // https://discord.com/api/webhooks/...
      events: ['bug.created']
    },
    custom: {
      enabled: false,
      url: '',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      events: ['bug.created', 'session.complete', 'index.updated']
    }
  },

  // ---- MCP (Model Context Protocol) ----
  // Point ERplorer at an MCP server to expose search/index actions as tools.
  // Example: run a local server at http://localhost:3000/mcp
  mcp: {
    enabled: false,
    serverUrl: '',
    name: 'erplorer',
    tools: ['search', 'get_result', 'list_patterns', 'run_session']
  },

  // ---- CDN URLs for lazy-loaded libraries ----
  cdn: {
    flexsearch:  'https://cdn.jsdelivr.net/gh/nextapps-de/flexsearch@0.8.2/dist/flexsearch.bundle.min.js',
    sheetjs:     'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    html2canvas: 'https://esm.sh/html2canvas@1.4.1',
    jspdf:       'https://esm.sh/jspdf@2.5.1',
    tesseract:   'https://esm.sh/tesseract.js@5.0.4'
  },

  // ---- UI preferences ----
  ui: {
    defaultTheme: 'light',   // 'light' | 'dark'
    itemsPerPage: 25,
    showUSPBanner: true
  }
};