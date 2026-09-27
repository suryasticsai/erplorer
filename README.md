# ERplorer Runner

Companion Node service for ERplorer. ERplorer itself stays a static,
zero-build client app — this is the piece that actually drives a real
browser (Playwright/Chromium) and fires real HTTP requests (Postman-style),
because neither of those can run inside a static page.

## Setup

```bash
cd erplorer-runner
npm install
npm run install-browsers   # downloads Chromium for Playwright, one-time
npm start                  # listens on http://localhost:8787
```

Set `AI_PRIMARY` / `AI_FALLBACK` env vars if you want the `/ask` endpoint
to use different AI endpoints than the defaults (which mirror ERplorer's
own `erplorer.config.js`).

## Concepts

- **Session** = one QA run (e.g. one user story or one scenario set).
  Every browser step, every API call, all console output, and the full
  WebM video recording get logged into one `sessions/<id>/session.json`,
  a companion `flow.md` (human-readable, video-timestamp-cross-referenced),
  and per-step screenshots.
- Sessions are **temporary by default** (72h TTL, see `TTL_HOURS` in
  `lib/session.js`) and auto-deleted by a janitor sweep. Call
  `POST /session/:id/promote` to keep one permanently.
- `POST /session/:id/ask` runs a small local RAG pass (chunk + keyword-score
  + AI call) scoped to just that session — "why did step 4 fail" gets
  answered from that run's own log, not your whole history.

## Typical flow from ERplorer's frontend

```js
// 1. Start a session for a user story
const { sessionId } = await fetch('http://localhost:8787/session/start', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ title: 'Login flow', userStory: 'US-142' })
}).then(r => r.json());

// 2. Run the UI steps ERplorer's Lab tab already generates
await fetch(`http://localhost:8787/session/${sessionId}/ui-run`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ steps: currentRows.filter(isUiStep) })
});

// 3. Run API steps as a Postman-style collection (with chaining)
await fetch(`http://localhost:8787/session/${sessionId}/api-run`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    collection: {
      requests: [
        { name: 'login', method: 'POST', url: '{{baseUrl}}/login',
          body: { user: 'admin', pass: 'secret123' },
          extract: { token: 'data.token' } },
        { name: 'get profile', method: 'GET', url: '{{baseUrl}}/me',
          headers: { Authorization: 'Bearer {{token}}' },
          expectStatus: 200 }
      ]
    },
    vars: { baseUrl: 'https://api.example.com' }
  })
});

// 4. Close it out
await fetch(`http://localhost:8787/session/${sessionId}/finish`, { method: 'POST' });

// 5. Query it
const { answer } = await fetch(`http://localhost:8787/session/${sessionId}/ask`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ question: 'Which requests failed and why?' })
}).then(r => r.json());

// 6. Fetch the recording + flow doc
// GET /session/:id/video     -> video/webm
// GET /session/:id/flow.md   -> markdown transcript
```

## Wiring into erplorer.js

Add a `runner` block to `erplorer.config.js`:

```js
runner: { baseUrl: 'http://localhost:8787' }
```

Then a thin client module (not included yet — say the word and I'll add
`erplorer-runner-client.js` with UI buttons wired into the existing Lab
and Ingest panels) turns "Generate specs" into "Generate specs → Run now
→ see video + ask questions," closing the loop end to end.
