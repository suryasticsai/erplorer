'use strict';
/**
 * Minimal RAG layer over session data.
 *
 * No external vector DB — chunks session text, scores chunks against
 * a query with TF-IDF-ish overlap (good enough for "what did step 4
 * do" / "which request returned 500" style questions over a single
 * session's worth of text), then hands the top chunks + the question
 * to the AI endpoint ERplorer already talks to (aiPrimary/aiFallback),
 * so this file has no hard dependency on a specific model provider.
 *
 * Swap `scoreChunks` for a real embedding model later without
 * touching the calling code in server.js.
 */

const STOP = new Set(['the','a','an','of','in','on','to','for','and','is','was','were','at','by','with','this','that']);

function tokenize(s) {
  return String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function chunkText(text, maxLen = 600) {
  const lines = text.split('\n').filter(Boolean);
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    if (curLen + line.length > maxLen && cur.length) {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

function scoreChunks(query, chunks) {
  const qTokens = tokenize(query).filter(t => !STOP.has(t));
  return chunks
    .map(c => {
      const cTokens = tokenize(c);
      const cSet = new Set(cTokens);
      let score = 0;
      for (const t of qTokens) if (cSet.has(t)) score++;
      return { chunk: c, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Ask a question scoped to one session.
 * `aiCall` is an injected async function (question, context) => answerString
 * so this module stays provider-agnostic (Vercel/Pollinations/etc — same
 * pattern as erplorer.js's askNatural()).
 */
async function askSession(session, question, aiCall, topK = 6) {
  const fullText = session.toRagText();
  const chunks = chunkText(fullText);
  const ranked = scoreChunks(question, chunks).slice(0, topK).filter(r => r.score > 0);

  const context = ranked.length
    ? ranked.map((r, i) => `[chunk ${i + 1}]\n${r.chunk}`).join('\n\n')
    : fullText.slice(0, 3000); // fallback: no keyword overlap, just give recent context

  const prompt = `You are answering questions about a QA test session log (browser steps + API requests + console output).\n\nRelevant excerpts:\n\n${context}\n\nQuestion: ${question}\n\nAnswer concisely, citing step/request timestamps (the "t=...ms" markers) where relevant.`;

  const answer = await aiCall(prompt);
  return { answer, chunksUsed: ranked.length, session: session.meta.id };
}

module.exports = { chunkText, scoreChunks, askSession };
