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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, fetchRepoFiles, fetchCommits } from './lib/github.mjs';
import { buildScan } from './lib/scan.mjs';

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

const app = express();
app.disable('x-powered-by');

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
app.get('/api/pulse', rateLimit('pulse', 120, 15 * 60 * 1000), async (req, res) => {
  if (!HATI_URL || !MAPPER_TOKEN) {
    return res.json({
      available: false,
      reason: !HATI_URL
        ? 'HATI_URL is not set on the Mapper, so there is no running HaTi to ask.'
        : 'MAPPER_TOKEN is not set on the Mapper, so HaTi will not answer.',
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${HATI_URL}/api/pulse`, {
      headers: { Authorization: `Bearer ${MAPPER_TOKEN}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (r.status === 404) {
      return res.json({ available: false, reason: 'HaTi returned 404 — MAPPER_TOKEN is not set on HaTi, so the endpoint does not exist there. That is the off switch working.' });
    }
    if (r.status === 401) {
      return res.json({ available: false, reason: 'HaTi rejected the token — the MAPPER_TOKEN set here does not match the one set on HaTi.' });
    }
    if (!r.ok) return res.json({ available: false, reason: `HaTi answered ${r.status}.` });
    const data = await r.json();
    res.json({ available: true, ...data, fetchedAt: new Date().toISOString() });
  } catch (e) {
    const why = e.name === 'AbortError' ? 'HaTi did not answer within 12 seconds.' : `HaTi could not be reached (${e.message}).`;
    res.json({ available: false, reason: why });
  } finally {
    clearTimeout(timer);
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
