'use strict';
/**
 * Saved Collections — persisted Postman-style request collections.
 *
 * Without this, every /session/:id/api-run call requires the caller
 * to resend the full collection JSON (requests + vars) from scratch.
 * This module lets a collection be named and saved once, then reused
 * across sessions by name — matching how Postman collections work.
 *
 * Stored as flat JSON files under /collections/<name>.json. Small
 * and simple by design; if this ever needs to be shared across a
 * team rather than one machine, swap the fs calls for a real DB
 * without changing the route shapes in server.js.
 */

const fs = require('fs');
const path = require('path');

const COLLECTIONS_DIR = path.join(__dirname, '..', 'collections');

function ensureDir() {
  if (!fs.existsSync(COLLECTIONS_DIR)) fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
}

function slugName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function filePath(name) {
  return path.join(COLLECTIONS_DIR, slugName(name) + '.json');
}

function save(name, collection, vars) {
  ensureDir();
  if (!name) throw new Error('collection name required');
  const data = {
    name,
    savedAt: new Date().toISOString(),
    collection: collection || { requests: [] },
    vars: vars || {}
  };
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
  return data;
}

function load(name) {
  const f = filePath(name);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

function list() {
  ensureDir();
  return fs.readdirSync(COLLECTIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(COLLECTIONS_DIR, f), 'utf-8'));
      return {
        name: data.name,
        savedAt: data.savedAt,
        requestCount: (data.collection.requests || []).length
      };
    })
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

function remove(name) {
  const f = filePath(name);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

module.exports = { save, load, list, remove, COLLECTIONS_DIR };
