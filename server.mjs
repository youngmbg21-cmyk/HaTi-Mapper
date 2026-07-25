/* HaTi-Mapper — the whole back end.
 *
 * Serves the front end and exposes two routes:
 *
 *   GET /api/scan   — reads the HaTi repository and returns the seven
 *                     code-derived panels as one JSON payload.
 *   GET /api/pulse  — calls HaTi's own read-only /api/pulse and returns the
 *                     caps in force and today's usage.
 *
 * The server holds every secret, so nothing sensitive reaches the browser, and
 * it calls HaTi server-to-server, which means CORS never enters the picture.
 *
 * There is no access prompt: the page loads straight into the data. That means
 * anyone who reaches this URL sees HaTi's file paths, its routes that work
 * without logging in, and its known weaknesses — so the URL is the only thing
 * keeping this private. Keep it unlisted, and prefer a network-level control
 * (an IP allow-list or your host's own access control) if it ever needs one.
 *
 * The secrets below are still server-side only and never reach the browser.
 *
 * Environment (all set in the Render dashboard, none in any served file):
 *   GITHUB_TOKEN   fine-grained PAT, read-only, scoped to the HaTi repo
 *   HATI_URL       base URL of the running HaTi instance
 *   MAPPER_TOKEN   bearer credential HaTi's /api/pulse requires
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, fetchRepoFiles, fetchCommits } from './lib/github.mjs';
import { buildScan } from './lib/scan.mjs';
import { History } from './lib/history.mjs';
import { CHAT_TOOLS, buildSystem, runTool, normalizeAnswer } from './lib/chat.mjs';
import { messages as anthropicMessages, friendlyError, DEFAULT_MODEL } from './lib/anthropic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const REPO = process.env.HATI_REPO || 'youngmbg21-cmyk/mkataba-clm';
const REF = process.env.HATI_REF || 'main';
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const HATI_URL = (process.env.HATI_URL || '').trim().replace(/\/+$/, '');
const MAPPER_TOKEN = (process.env.MAPPER_TOKEN || '').trim();

const CACHE_MS = 10 * 60 * 1000;   // the code does not change minute to minute
/* The commit list is one call; each commit's file list is another, so a cold
   scan costs about COMMIT_COUNT + 2 requests. At the documented 20 that is 22
   per scan against an authenticated ceiling of 5,000 an hour, and the
   ten-minute cache holds it to roughly 130 an hour at worst. */
const COMMIT_COUNT = Number(process.env.COMMIT_COUNT || 20);

/* Where the 72-hour change log and any pasted AI key are kept. On Render this
   survives restarts but not a redeploy unless a disk is attached — the README
   says so, and both degrade to memory rather than failing.

   Deliberately NOT `data/`: that directory holds the hand-maintained
   dependency map and phrasebook, which are source, not runtime state. Mixing
   generated files in with them invites exactly the accident of deleting one
   while clearing the other. */
const DATA_DIR = process.env.MAPPER_DATA || path.join(__dirname, '.mapper-state');
const history = new History(DATA_DIR);

/* ---------------------------------------------------------- the AI brain */

/* The key can come from the environment or be pasted into the page. The
   environment wins: the Mapper has no login, so a key set in Render cannot be
   changed by anyone who merely reaches the URL, and that is the safer of the
   two. A pasted key is only used when no environment key exists. */
const ENV_AI_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const AI_MODEL = (process.env.ANTHROPIC_MODEL || '').trim() || DEFAULT_MODEL;
const KEY_FILE = path.join(DATA_DIR, 'ai-key.json');

let pastedKey = '';
try {
  pastedKey = (JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).key || '').trim();
} catch (_) { /* no key stored yet — normal */ }

const aiKey = () => ENV_AI_KEY || pastedKey;
const aiKeySource = () => (ENV_AI_KEY ? 'environment' : (pastedKey ? 'pasted' : null));

function savePastedKey(key) {
  pastedKey = (key || '').trim();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (pastedKey) fs.writeFileSync(KEY_FILE, JSON.stringify({ key: pastedKey }), { mode: 0o600 });
    else fs.rmSync(KEY_FILE, { force: true });
    return true;
  } catch (e) {
    console.warn('[chat] the key could not be written to disk, so it will be lost on restart:', e.message);
    return false;
  }
}

/* A daily ceiling on chat turns, mirroring HaTi's blunt request counter. The
   Mapper has no login, so without this an open URL could spend the owner's
   Anthropic credit indefinitely. Resets at UTC midnight. */
const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT || 200);
let chatDay = '', chatCount = 0;
function chatBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== chatDay) { chatDay = today; chatCount = 0; }
  return { date: chatDay, used: chatCount, limit: CHAT_DAILY_LIMIT };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ guard */

/* A small sliding-window limiter, same shape as HaTi's. It is now the only
   thing standing between an open URL and an unbounded number of repository
   downloads, so it stays. */
const hits = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const id = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const key = bucket + ':' + id;
    const nowMs = Date.now();
    const arr = (hits.get(key) || []).filter(t => nowMs - t < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    arr.push(nowMs); hits.set(key, arr);
    next();
  };
}
setInterval(() => {
  const nowMs = Date.now();
  for (const [k, arr] of hits) {
    const keep = arr.filter(t => nowMs - t < 3600000);
    if (keep.length) hits.set(k, keep); else hits.delete(k);
  }
}, 600000).unref?.();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* --------------------------------------------------------------- /api/scan */

/* Cached for ten minutes. Every scan costs a repository download, and the code
   does not change minute to minute. `?refresh=1` (the Rescan button) bypasses
   it. On Render's free tier the process is spun down after inactivity, so this
   cache dies with it and the first load after an idle period pays full price —
   the front end says so rather than appearing to hang. */
let cache = null;          // { at, payload }
let inFlight = null;       // coalesces concurrent cold scans into one download

async function runScan() {
  const started = Date.now();
  const client = makeClient(GITHUB_TOKEN);
  const files = await fetchRepoFiles(client, REPO, REF);

  // Commit history is best-effort: the seven code-derived panels do not need
  // it, so a commits failure must not take the whole scan down with it.
  let commits = null, commitError = null;
  try {
    commits = await fetchCommits(client, REPO, REF, COMMIT_COUNT);
  } catch (e) {
    commitError = e.message;
  }

  const payload = buildScan({ files, commits, repo: REPO, ref: REF, requestCount: client.requests });
  payload.tookMs = Date.now() - started;
  payload.tokenConfigured = !!GITHUB_TOKEN;
  if (commitError) payload.warnings.push(`Commit history could not be read: ${commitError}`);
  if (!GITHUB_TOKEN) payload.warnings.push('GITHUB_TOKEN is not set — GitHub allows only 60 unauthenticated requests an hour, so scans will start failing.');

  /* Every fresh scan is compared with the last one and anything that moved is
     written to the 72-hour log. Scans that find nothing changed add nothing,
     so the log stays a list of real events rather than a list of look-ups. */
  try {
    const events = history.record(payload);
    if (events.length) console.log(`[history] ${events.length} change(s) noticed in this scan.`);
  } catch (e) {
    console.warn('[history] could not record this scan:', e.message);
  }
  payload.history = history.status();
  return payload;
}

app.get('/api/scan', rateLimit('scan', 60, 15 * 60 * 1000), async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return res.json({ ...cache.payload, cached: true, cacheAgeMs: Date.now() - cache.at });
  }
  try {
    if (!inFlight) {
      inFlight = runScan().finally(() => { inFlight = null; });
    }
    const payload = await inFlight;
    cache = { at: Date.now(), payload };
    res.json({ ...payload, cached: false, cacheAgeMs: 0 });
  } catch (e) {
    console.error('[scan] failed:', e.message);
    // Serve stale rather than nothing — a ten-minute-old map beats an error.
    if (cache) {
      return res.json({ ...cache.payload, cached: true, stale: true, cacheAgeMs: Date.now() - cache.at,
        warnings: [...cache.payload.warnings, `The latest rescan failed (${e.message}). Showing the last good scan.`] });
    }
    res.status(502).json({ error: 'The repository scan failed.', detail: e.message });
  }
});

/* -------------------------------------------------------------- /api/pulse */

/* The only thing that touches a running HaTi. It is called server-to-server
   with MAPPER_TOKEN as a bearer credential; the token never reaches the
   browser. Everything this returns is a number or a boolean. */
async function readPulse() {
  if (!HATI_URL || !MAPPER_TOKEN) {
    return {
      available: false,
      reason: !HATI_URL
        ? 'HATI_URL is not set on the Mapper, so there is no running HaTi to ask.'
        : 'MAPPER_TOKEN is not set on the Mapper, so HaTi will not answer.',
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${HATI_URL}/api/pulse`, {
      headers: { Authorization: `Bearer ${MAPPER_TOKEN}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (r.status === 404) return { available: false, reason: 'HaTi returned 404 — MAPPER_TOKEN is not set on HaTi, so the endpoint does not exist there. That is the off switch working.' };
    if (r.status === 401) return { available: false, reason: 'HaTi rejected the token — the MAPPER_TOKEN set here does not match the one set on HaTi.' };
    if (!r.ok) return { available: false, reason: `HaTi answered ${r.status}.` };
    return { available: true, ...(await r.json()), fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { available: false, reason: e.name === 'AbortError' ? 'HaTi did not answer within 12 seconds.' : `HaTi could not be reached (${e.message}).` };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/pulse', rateLimit('pulse', 120, 15 * 60 * 1000), async (req, res) => {
  res.json(await readPulse());
});

/* ------------------------------------------------------------ /api/changes */

/* The Mapper's own watch log: what has actually moved in the last 72 hours,
   already written in plain English by lib/history.mjs. */
app.get('/api/changes', rateLimit('changes', 120, 15 * 60 * 1000), (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 72);
  res.json({ ...history.status(), hours, rounds: history.changes(hours) });
});

/* --------------------------------------------------------- /api/ai/config */

/* What the page needs to know about the brain — never the key itself. The
   hint is the last four characters, which is enough to tell two keys apart
   and not enough to be one. */
app.get('/api/ai/config', rateLimit('aiconfig', 120, 15 * 60 * 1000), (req, res) => {
  const k = aiKey();
  res.json({
    configured: !!k,
    source: aiKeySource(),
    hint: k ? '••••' + k.slice(-4) : '',
    model: AI_MODEL,
    lockedToEnvironment: !!ENV_AI_KEY,
    budget: chatBudget(),
    storageIsDurable: history.status().durable,
  });
});

/* Paste or clear a key. Only available when the environment has not set one:
   with no login on this service, a key set in Render should not be replaceable
   from the browser. */
app.put('/api/ai/config', rateLimit('aiconfigw', 20, 15 * 60 * 1000), (req, res) => {
  if (ENV_AI_KEY) {
    return res.status(409).json({
      error: 'The key is set by an environment variable on this service, so it cannot be changed from this page. Change ANTHROPIC_API_KEY in the Render dashboard instead.',
    });
  }
  const body = req.body || {};
  if (body.clear) {
    savePastedKey('');
    console.log('[chat] the pasted AI key was cleared.');
    return res.json({ configured: false, source: null, hint: '' });
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return res.status(400).json({ error: 'Paste a key, or send clear:true to remove the one that is saved.' });
  if (!/^sk-ant-/.test(key)) {
    return res.status(400).json({ error: 'That does not look like an Anthropic key — they begin with "sk-ant-". Copy the whole thing from console.anthropic.com.' });
  }
  const durable = savePastedKey(key);
  console.log('[chat] a new AI key was saved from the page.');
  res.json({ configured: true, source: 'pasted', hint: '••••' + key.slice(-4), durable });
});

/* --------------------------------------------------------------- /api/chat */

/* The assistant. Same tool loop as HaTi's Copilot: the model fetches what it
   needs, then calls deliver_answer exactly once. It reads only the scan, the
   change log and the live caps — the same things the dashboard shows — so it
   has no route to HaTi's contract data even if asked. */
app.post('/api/chat', rateLimit('chat', 40, 15 * 60 * 1000), async (req, res) => {
  const key = aiKey();
  if (!key) {
    return res.status(400).json({ error: 'No AI key is set yet, so the assistant has no brain to think with.', needsKey: true });
  }

  const budget = chatBudget();
  if (CHAT_DAILY_LIMIT > 0 && budget.used >= CHAT_DAILY_LIMIT) {
    return res.status(429).json({
      error: `The assistant has answered its daily limit of ${CHAT_DAILY_LIMIT} questions. This resets at midnight UTC, and the limit exists so an open page cannot run up an Anthropic bill.`,
      budget,
    });
  }

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const convo = incoming
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!convo.length || convo[convo.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'The last message needs to be a question from you.' });
  }

  /* The assistant answers from the cached scan. It never triggers a fresh
     repository download — asking a question should not cost a scan. */
  if (!cache) {
    return res.status(409).json({ error: 'The platform has not been scanned yet, so there is nothing for me to read. Let the page finish loading, then ask again.' });
  }
  const scan = cache.payload;

  let pulse = null;
  try { pulse = await readPulse(); } catch (_) { pulse = { available: false }; }

  const system = buildSystem({ scan, historyStatus: history.status(), pulse });
  const working = convo.slice();
  const ctx = { scan, history, pulse };
  let final = null, usedModel = AI_MODEL, toolsUsed = [];

  chatCount++;
  try {
    for (let step = 0; step < 5; step++) {
      const resp = await anthropicMessages(key, { max_tokens: 1600, system, tools: CHAT_TOOLS, messages: working }, AI_MODEL);
      if (!resp.ok) {
        console.warn('[chat] Anthropic error', resp.status);
        return res.status(502).json({ error: friendlyError(resp) });
      }
      usedModel = resp.model;
      const content = resp.data.content || [];
      working.push({ role: 'assistant', content });

      const toolUses = content.filter(b => b.type === 'tool_use');
      if (!toolUses.length) {
        const txt = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        final = normalizeAnswer({ answer: txt });
        break;
      }

      const deliver = toolUses.find(t => t.name === 'deliver_answer');
      if (deliver) { final = normalizeAnswer(deliver.input); break; }

      const results = toolUses.map(t => {
        toolsUsed.push(t.name);
        let out;
        try { out = runTool(t.name, t.input, ctx); }
        catch (e) { out = { error: e.message }; }
        return { type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(out).slice(0, 60000) };
      });
      working.push({ role: 'user', content: results });
    }

    if (!final) {
      final = normalizeAnswer({ answer: 'I could not finish working that one out. Try asking it a slightly different way, or narrow it to one part of the platform.' });
    }
    res.json({ ...final, model: usedModel, toolsUsed, budget: chatBudget() });
  } catch (e) {
    console.error('[chat] failed:', e.message);
    res.status(502).json({ error: `The assistant could not complete that: ${e.message}` });
  }
});

/* ------------------------------------------------------------ front end */

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* Exactly two files are servable. Nothing else in this directory — not lib/,
   not data/, not server.mjs, not package.json — is reachable over HTTP, so an
   allow-list is used rather than express.static over the repository root. */
const SERVABLE = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
for (const [url, [file, type]] of Object.entries(SERVABLE)) {
  app.get(url, (req, res) => {
    res.type(type);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, file));
  });
}

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`[mapper] listening on :${PORT}`);
  console.log(`[mapper] repo ${REPO}@${REF}; GITHUB_TOKEN ${GITHUB_TOKEN ? 'set' : 'NOT SET'}; HATI_URL ${HATI_URL || 'NOT SET'}; MAPPER_TOKEN ${MAPPER_TOKEN ? 'set' : 'NOT SET'}`);
});
