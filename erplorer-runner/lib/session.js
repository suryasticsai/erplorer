'use strict';
/**
 * Session — one QA run (e.g. "one user story" or one scenario set).
 *
 * Everything that happens during a run (browser steps, API requests,
 * console errors, screenshots, video) gets appended to a single
 * structured JSON file under /sessions/<id>/session.json.
 *
 * That file is the "temporary RAG" source: chunk it + embed it (see
 * lib/rag.js) so the Ask panel can be scoped to just this run.
 *
 * Sessions are temporary by default — call markExpired() or rely on
 * the janitor in server.js to clean up after TTL_HOURS.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
const TTL_HOURS = 72; // temporary by default; promote to keep longer

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

class Session {
  constructor({ title, userStory } = {}) {
    this.id = uuidv4();
    this.dir = path.join(SESSIONS_DIR, this.id);
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, 'screenshots'));

    this.meta = {
      id: this.id,
      title: title || 'Untitled session',
      userStory: userStory || null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString(),
      permanent: false,
      status: 'running',
      videoFile: null
    };

    this.steps = [];      // browser actions (click, fill, goto, assertions...)
    this.requests = [];    // Postman-style API calls
    this.consoleLogs = []; // page console + errors
    this._t0 = Date.now();

    this._flush();
  }

  static load(id) {
    const dir = path.join(SESSIONS_DIR, id);
    const file = path.join(dir, 'session.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const s = Object.create(Session.prototype);
    Object.assign(s, data);
    s.dir = dir;
    return s;
  }

  static list() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => fs.existsSync(path.join(SESSIONS_DIR, f, 'session.json')))
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f, 'session.json'), 'utf-8'));
        return data.meta;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  elapsedMs() {
    return Date.now() - this._t0;
  }

  logStep(step) {
    // step: { action, selector, value, url, status ('ok'|'error'), error, screenshot }
    this.steps.push(Object.assign({
      t: this.elapsedMs(),
      ts: new Date().toISOString()
    }, step));
    this._flush();
  }

  logRequest(req) {
    // req: { method, url, headers, body, response: { status, headers, body, timeMs }, chainVars }
    this.requests.push(Object.assign({
      t: this.elapsedMs(),
      ts: new Date().toISOString()
    }, req));
    this._flush();
  }

  logConsole(entry) {
    this.consoleLogs.push(Object.assign({
      t: this.elapsedMs(),
      ts: new Date().toISOString()
    }, entry));
    // don't flush on every console line — too chatty; flushed with next step/request
  }

  setVideo(videoFile) {
    this.meta.videoFile = videoFile;
    this._flush();
  }

  finish(status) {
    this.meta.status = status || 'completed';
    this.meta.finishedAt = new Date().toISOString();
    this.meta.durationMs = this.elapsedMs();
    this._flush();
    this._writeMarkdown();
  }

  promote() {
    this.meta.permanent = true;
    this.meta.expiresAt = null;
    this._flush();
  }

  _flush() {
    const out = {
      meta: this.meta,
      steps: this.steps,
      requests: this.requests,
      consoleLogs: this.consoleLogs
    };
    fs.writeFileSync(path.join(this.dir, 'session.json'), JSON.stringify(out, null, 2));
  }

  /**
   * Human-readable flow doc — a readable companion to the JSON,
   * cross-referencing video timestamps with steps, exactly like a
   * narrated recording transcript.
   */
  _writeMarkdown() {
    const lines = [];
    lines.push(`# Session: ${this.meta.title}`);
    if (this.meta.userStory) lines.push(`**User story:** ${this.meta.userStory}`);
    lines.push(`**Started:** ${this.meta.createdAt}`);
    lines.push(`**Status:** ${this.meta.status}`);
    if (this.meta.videoFile) lines.push(`**Video:** ${this.meta.videoFile}`);
    lines.push('');
    lines.push('## Timeline');
    lines.push('');

    const all = [
      ...this.steps.map(s => ({ ...s, _kind: 'step' })),
      ...this.requests.map(r => ({ ...r, _kind: 'request' }))
    ].sort((a, b) => a.t - b.t);

    for (const e of all) {
      const tSec = (e.t / 1000).toFixed(1) + 's';
      if (e._kind === 'step') {
        lines.push(`- **[${tSec}]** \`${e.action}\`${e.selector ? ` on \`${e.selector}\`` : ''}${e.value ? ` = "${e.value}"` : ''} — ${e.status}${e.error ? ` (${e.error})` : ''}`);
      } else {
        lines.push(`- **[${tSec}]** \`${e.method}\` ${e.url} → ${e.response ? e.response.status : '?'} (${e.response ? e.response.timeMs : '?'}ms)`);
      }
    }

    if (this.consoleLogs.length) {
      lines.push('', '## Console output', '');
      for (const c of this.consoleLogs.slice(0, 200)) {
        lines.push(`- [${(c.t / 1000).toFixed(1)}s] (${c.level || 'log'}) ${c.text}`);
      }
    }

    fs.writeFileSync(path.join(this.dir, 'flow.md'), lines.join('\n'));
  }

  /** Flat text used by the RAG indexer (lib/rag.js) */
  toRagText() {
    const parts = [`Session: ${this.meta.title}`, this.meta.userStory ? `User story: ${this.meta.userStory}` : ''];
    for (const s of this.steps) {
      parts.push(`Step at ${s.t}ms: action=${s.action} selector=${s.selector || ''} value=${s.value || ''} status=${s.status} ${s.error || ''}`);
    }
    for (const r of this.requests) {
      parts.push(`API at ${r.t}ms: ${r.method} ${r.url} -> status=${r.response ? r.response.status : '?'} body=${r.response ? JSON.stringify(r.response.body).slice(0, 500) : ''}`);
    }
    for (const c of this.consoleLogs) {
      parts.push(`Console at ${c.t}ms: ${c.text}`);
    }
    return parts.filter(Boolean).join('\n');
  }
}

function janitor() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const now = Date.now();
  for (const id of fs.readdirSync(SESSIONS_DIR)) {
    const file = path.join(SESSIONS_DIR, id, 'session.json');
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (data.meta.permanent) continue;
      if (data.meta.expiresAt && new Date(data.meta.expiresAt).getTime() < now) {
        fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true });
        console.log(`[janitor] expired session removed: ${id}`);
      }
    } catch (e) { /* skip corrupt */ }
  }
}

module.exports = { Session, janitor, SESSIONS_DIR };
