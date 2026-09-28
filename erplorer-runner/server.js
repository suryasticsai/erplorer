'use strict';
/**
 * ERplorer Runner — companion Node service.
 *
 * Run: npm install && npm run install-browsers && npm start
 * Default port: 8787 (set PORT env var to change)
 *
 * Endpoints:
 *
 *   GET    /health                                 -> { ok, version }
 *   GET    /sessions                               -> list of session metadata
 *   POST   /session/start        { title, userStory }              -> { sessionId }
 *   GET    /session/:id                                            -> full session JSON
 *   POST   /session/:id/ui-run   { steps: [...], headless? }       -> { ok, sessionId, videoFile }
 *   POST   /session/:id/api-run  { collection: {...}, vars: {...} } -> { ok, results }
 *   POST   /session/:id/api-run-saved/:collectionName { vars? }     -> { ok, results }
 *   POST   /session/:id/finish   { status? }                       -> { ok }
 *   POST   /session/:id/promote  {}                                -> { ok, meta }
 *   POST   /session/:id/ask      { question }                      -> { answer }
 *   GET    /session/:id/flow.md                                    -> human-readable flow doc
 *   GET    /session/:id/video                                      -> WebM recording
 *
 *   POST   /collections/:name    { collection, vars? }             -> { ok, saved }
 *   GET    /collections                                            -> list
 *   GET    /collections/:name                                      -> full collection
 *   DELETE /collections/:name                                      -> { ok }
 *
 *   POST   /bench/load           { url, method, concurrency, ... } -> load test result
 *
 * AI calls for /session/:id/ask reuse the same two-tier pattern as
 * ERplorer's own erplorer.config.js (primary + fallback).
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
const { runLoadTest } = require('./lib/loadtest');

const PORT = process.env.PORT || 8787;

// Same endpoints ERplorer's erplorer.config.js already points at —
// reuse them so there's one AI config, not two.
const AI_PRIMARY = process.env.AI_PRIMARY || 'https://ragina-crawler-ragina.vercel.app/api/ask';
const AI_FALLBACK = process.env.AI_FALLBACK || 'https://text.pollinations.ai/openai';

// ============================================================
// AI adapter — injected into rag.js
// ============================================================
async function aiCall(prompt) {
  // Primary
  try {
    const res = await fetch(AI_PRIMARY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: prompt, context: 'QA session assistant' })
    });
    if (res.ok) {
      const d = await res.json();
      const answer = d.answer || d.content || d.response
        || (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
      if (answer) return answer;
    }
  } catch (e) {
    console.warn('[ai] primary failed:', e.message);
  }

  // Fallback
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
      return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content)
        || 'No answer available.';
    }
  } catch (e) {
    console.warn('[ai] fallback failed:', e.message);
  }

  return 'AI endpoints unreachable — check erplorer-runner AI_PRIMARY/AI_FALLBACK config.';
}

// ============================================================
// APP
// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'erplorer-runner',
    version: '1.0.0',
    uptime: process.uptime(),
    endpoints: {
      aiPrimary: AI_PRIMARY,
      aiFallback: AI_FALLBACK
    }
  });
});

// ============================================================
// SESSIONS
// ============================================================
app.post('/session/start', (req, res) => {
  try {
    const { title, userStory } = req.body || {};
    const session = new Session({ title, userStory });
    res.json({ sessionId: session.id, meta: session.meta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/sessions', (req, res) => {
  try {
    res.json(Session.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json({
    meta: session.meta,
    steps: session.steps,
    requests: session.requests,
    consoleLogs: session.consoleLogs
  });
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

app.get('/session/:id/screenshot/:name', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const safe = String(req.params.name).replace(/[^\w.-]/g, '_');
  const p = path.join(session.dir, 'screenshots', safe);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'screenshot not found' });
  res.type('image/png').sendFile(p);
});

app.post('/session/:id/finish', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  session.finish((req.body || {}).status);
  res.json({ ok: true, meta: session.meta });
});

app.post('/session/:id/promote', (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  session.promote();
  res.json({ ok: true, meta: session.meta });
});

app.delete('/session/:id', (req, res) => {
  try {
    const dir = path.join(__dirname, 'sessions', req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// UI RUN (Playwright)
// ============================================================
app.post('/session/:id/ui-run', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });

  const { steps = [], headless = true, stopOnError = false } = req.body || {};
  if (!Array.isArray(steps) || !steps.length) {
    return res.status(400).json({ error: 'steps array required' });
  }

  try {
    const result = await runUiSteps(session, steps, { headless, stopOnError });
    res.json(Object.assign({ sessionId: session.id }, result));
  } catch (e) {
    console.error('[ui-run]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API RUN (Postman-style)
// ============================================================
app.post('/session/:id/api-run', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });

  const { collection = { requests: [] }, vars = {} } = req.body || {};
  try {
    const result = await runCollection(session, collection, vars);
    res.json(result);
  } catch (e) {
    console.error('[api-run]', e);
    res.status(500).json({ error: e.message });
  }
});

// Run a saved collection directly against a session
app.post('/session/:id/api-run-saved/:collectionName', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });

  const saved = collections.load(req.params.collectionName);
  if (!saved) return res.status(404).json({ error: 'collection not found' });

  try {
    const overrideVars = (req.body || {}).vars || {};
    const merged = Object.assign({}, saved.vars || {}, overrideVars);
    const result = await runCollection(session, saved.collection, merged);
    res.json(result);
  } catch (e) {
    console.error('[api-run-saved]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ASK THIS SESSION (scoped RAG)
// ============================================================
app.post('/session/:id/ask', async (req, res) => {
  const session = Session.load(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });

  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    const result = await askSession(session, question, aiCall);
    res.json(result);
  } catch (e) {
    console.error('[ask]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SAVED COLLECTIONS
// ============================================================
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
  try {
    res.json(collections.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ============================================================
// LOAD TEST (real concurrency, no browser cap)
// ============================================================
app.post('/bench/load', async (req, res) => {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    concurrency = 5,
    durationMs = 10000
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'url required' });
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url must start with http:// or https://' });

  const safeConcurrency = Math.max(1, Math.min(500, Number(concurrency) || 5));
  const safeDuration = Math.max(1000, Math.min(300000, Number(durationMs) || 10000));

  try {
    const result = await runLoadTest({
      url,
      method: String(method).toUpperCase(),
      headers,
      body,
      concurrency: safeConcurrency,
      durationMs: safeDuration
    });
    res.json(result);
  } catch (err) {
    console.error('[bench/load]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// JANITOR — expire old temporary sessions
// ============================================================
janitor();
setInterval(janitor, 6 * 3600 * 1000);

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log('ERplorer Runner listening on http://localhost:' + PORT);
  console.log('  AI primary : ' + AI_PRIMARY);
  console.log('  AI fallback: ' + AI_FALLBACK);
  console.log('  Sessions   : ' + path.join(__dirname, 'sessions'));
  console.log('  Collections: ' + path.join(__dirname, 'collections'));
});