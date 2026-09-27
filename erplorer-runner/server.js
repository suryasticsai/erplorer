'use strict';
/**
 * ERplorer Runner — companion Node service.
 *
 * Run: npm install && npm run install-browsers && npm start
 * Default port: 8787 (set PORT env var to change)
 *
 * Endpoints (all JSON in/out unless noted):
 *
 *   POST /session/start        { title, userStory }               -> { sessionId }
 *   POST /session/:id/ui-run   { steps: [...], headless? }         -> { ok, sessionId }
 *   POST /session/:id/api-run  { collection: {...}, vars: {...} }  -> { ok, results }
 *   POST /session/:id/api-run-saved/:collectionName  { vars? }     -> { ok, results }
 *   POST /session/:id/finish   { status? }                         -> { ok }
 *   POST /session/:id/promote  {}                                  -> { ok }  (keep beyond TTL)
 *   POST /session/:id/ask      { question }                        -> { answer }
 *   GET  /session/:id          ->  full session JSON
 *   GET  /session/:id/flow.md  ->  human-readable flow doc
 *   GET  /session/:id/video    ->  the WebM recording
 *   GET  /sessions             ->  list of session metadata
 *
 *   POST   /collections/:name  { collection: {...}, vars: {...} }  -> { ok, saved }
 *   GET    /collections        ->  list of saved collections
 *   GET    /collections/:name  ->  one saved collection
 *   DELETE /collections/:name  ->  { ok }
 *
 * AI calls for the /ask endpoint reuse the same two-tier pattern as
 * ERplorer's own erplorer.config.js (primary + fallback), configured
 * below — point these at whatever you already use.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { Session, janitor } = require('./lib/session');
const { runUiSteps } = require('./lib/browser');
const { runCollection } = require('./lib/api');
const { askSession } = require('./lib/rag');
const collections = require('./lib/collections');

const PORT = process.env.PORT || 8787;

// Same endpoints ERplorer's erplorer.config.js already points at —
// reuse them so there's one AI config, not two.
const AI_PRIMARY = process.env.AI_PRIMARY || 'https://ragina-crawler-ragina.vercel.app/api/ask';
const AI_FALLBACK = process.env.AI_FALLBACK || 'https://text.pollinations.ai/openai';

async function aiCall(prompt) {
  try {
    const res = await fetch(AI_PRIMARY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: prompt, context: 'QA session assistant' })
    });
    if (res.ok) {
      const d = await res.json();
      const answer = d.answer || d.content || d.response || (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
      if (answer) return answer;
    }
  } catch (e) { /* fall through */ }

  try {
    const res = await fetch(AI_FALLBACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: 'Answer about a QA test session log concisely.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (res.ok) {
      const d = await res.json();
      return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || 'No answer available.';
    }
  } catch (e) { /* offline */ }

  return 'AI endpoints unreachable — check erplorer-runner AI_PRIMARY/AI_FALLBACK config.';
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---- session lifecycle ----

app.post('/session/start', (req, res) => {
  const { title, userStory } = req.body || {};
  const session = new Session({ title, userStory });
  res.json({ sessionId: session.id, meta: session.meta });
});

app.get('/sessions', (req, res) => {
  res.json(Session.list());
});

app.get('/session/:id', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json({ meta: session.meta, steps: session.steps, requests: session.requests, consoleLogs: session.consoleLogs });
});

app.get('/session/:id/flow.md', (req, res) => {
  const file = path.join(__dirname, 'sessions', req.params.id, 'flow.md');
  if (!fs.existsSync(file)) return res.status(404).send('not found');
  res.type('text/markdown').send(fs.readFileSync(file, 'utf-8'));
});

app.get('/session/:id/video', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session || !session.meta.videoFile) return res.status(404).json({ error: 'no video for this session' });
  const videoPath = path.join(session.dir, session.meta.videoFile);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'video file missing' });
  res.type('video/webm').sendFile(videoPath);
});

app.post('/session/:id/finish', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  session.finish((req.body || {}).status);
  res.json({ ok: true });
});

app.post('/session/:id/promote', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  session.promote();
  res.json({ ok: true, meta: session.meta });
});

// ---- browser (Playwright) run ----

app.post('/session/:id/ui-run', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const { steps = [], headless = true, stopOnError = false } = req.body || {};
  try {
    const result = await runUiSteps(session, steps, { headless, stopOnError });
    res.json(Object.assign({ sessionId: session.id }, result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Postman-style API run ----

app.post('/session/:id/api-run', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const { collection = { requests: [] }, vars = {} } = req.body || {};
  try {
    const result = await runCollection(session, collection, vars);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run a saved collection directly against a session, without the
// caller resending the collection body each time.
app.post('/session/:id/api-run-saved/:collectionName', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const saved = collections.load(req.params.collectionName);
  if (!saved) return res.status(404).json({ error: 'collection not found' });
  try {
    const overrideVars = (req.body || {}).vars || {};
    const result = await runCollection(session, saved.collection, Object.assign({}, saved.vars, overrideVars));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- saved Postman-style collections ----

app.post('/collections/:name', (req, res) => {
  try {
    const { collection, vars } = req.body || {};
    const saved = collections.save(req.params.name, collection, vars);
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/collections', (req, res) => {
  res.json(collections.list());
});

app.get('/collections/:name', (req, res) => {
  const data = collections.load(req.params.name);
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(data);
});

app.delete('/collections/:name', (req, res) => {
  const ok = collections.remove(req.params.name);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---- Ask this session (scoped RAG) ----

app.post('/session/:id/ask', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    const result = await askSession(session, question, aiCall);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, version: '0.2.0' }));

// Expire old temporary sessions periodically
janitor();
setInterval(janitor, 6 * 3600 * 1000);

app.listen(PORT, () => {
  console.log(`ERplorer Runner listening on http://localhost:${PORT}`);
});
