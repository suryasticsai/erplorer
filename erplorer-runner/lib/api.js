'use strict';
/**
 * Postman-style request engine.
 *
 * A "collection" is an ordered list of requests. Each request can:
 *   - reference {{vars}} resolved from an env object
 *   - extract values from its response into vars for later requests
 *     (chaining), via `extract: { varName: "$.jsonpath" }` (dot-path,
 *     simplified — no full JSONPath library dependency)
 *   - carry assertions: expectStatus, expectJson (dot-path + expected)
 *
 * Every request + response is logged into the Session so it's part
 * of the flow doc and RAG index — this is what makes fetched values
 * queryable later via the Ask panel.
 */

function interpolate(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function interpolateDeep(obj, vars) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return interpolate(obj, vars);
  if (Array.isArray(obj)) return obj.map(v => interpolateDeep(v, vars));
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = interpolateDeep(obj[k], vars);
    return out;
  }
  return obj;
}

/** Very small dot-path getter: "data.items[0].name" */
function getPath(obj, pathStr) {
  if (!pathStr) return obj;
  const parts = pathStr.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function runRequest(session, req, vars) {
  const method = (req.method || 'GET').toUpperCase();
  const url = interpolate(req.url, vars);
  const headers = interpolateDeep(req.headers || {}, vars);
  const bodyRaw = req.body ? interpolateDeep(req.body, vars) : undefined;

  const fetchOpts = { method, headers };
  if (bodyRaw !== undefined && method !== 'GET' && method !== 'HEAD') {
    fetchOpts.body = typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw);
    if (!headers['Content-Type'] && !headers['content-type']) {
      fetchOpts.headers = Object.assign({ 'Content-Type': 'application/json' }, headers);
    }
  }

  const t0 = Date.now();
  let respStatus = null, respHeaders = {}, respBody = null, errMsg = null;

  try {
    const res = await fetch(url, fetchOpts);
    respStatus = res.status;
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    const text = await res.text();
    try { respBody = JSON.parse(text); } catch (e) { respBody = text; }
  } catch (e) {
    errMsg = e.message;
  }

  const timeMs = Date.now() - t0;

  // Run assertions
  const assertions = [];
  if (req.expectStatus != null) {
    const pass = respStatus === Number(req.expectStatus);
    assertions.push({ type: 'expectStatus', expected: req.expectStatus, actual: respStatus, pass });
  }
  if (req.expectJson) {
    for (const [jpath, expected] of Object.entries(req.expectJson)) {
      const actual = getPath(respBody, jpath);
      const pass = String(actual) === String(expected);
      assertions.push({ type: 'expectJson', path: jpath, expected, actual, pass });
    }
  }

  // Extract vars for chaining
  const newVars = {};
  if (req.extract) {
    for (const [varName, jpath] of Object.entries(req.extract)) {
      newVars[varName] = getPath(respBody, jpath);
    }
  }

  session.logRequest({
    name: req.name || `${method} ${url}`,
    method, url, headers: fetchOpts.headers, body: bodyRaw,
    response: { status: respStatus, headers: respHeaders, body: respBody, timeMs, error: errMsg },
    assertions,
    extractedVars: newVars
  });

  return {
    ok: !errMsg && assertions.every(a => a.pass),
    status: respStatus,
    body: respBody,
    vars: newVars,
    assertions,
    error: errMsg
  };
}

/**
 * Run a whole collection in order, threading extracted vars forward
 * (later requests can use vars extracted by earlier ones).
 */
async function runCollection(session, collection, initialVars = {}) {
  let vars = Object.assign({}, initialVars);
  const results = [];
  for (const req of collection.requests || []) {
    const r = await runRequest(session, req, vars);
    vars = Object.assign(vars, r.vars);
    results.push(r);
    if (!r.ok && collection.stopOnError) break;
  }
  return { results, finalVars: vars, ok: results.every(r => r.ok) };
}

module.exports = { runRequest, runCollection, getPath };
