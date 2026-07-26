/* HaTi-Mapper — the whole back end.
 *
 * Serves the front end (exactly two files) and these routes:
 *
 *   GET  /api/scan        — reads the HaTi repository and returns the eight
 *                           code-derived panels as one JSON payload.
 *   GET  /api/pulse       — calls HaTi's own read-only /api/pulse and returns
 *                           the caps in force and today's usage.
 *   GET  /api/changes     — the Mapper's own change log.
 *   GET  /api/ai/config   — what the page may know about the assistant's key.
 *   PUT  /api/ai/config   — set or clear that key from the Settings tab.
 *   POST /api/chat        — the assistant's tool loop.
 *   /api/auth/*           — set up, sign in, sign out, forgot, reset, change
 *                           password, sign out everywhere.
 *   GET  /api/health      — a liveness probe that returns nothing else.
 *
 * The server holds every secret, so nothing sensitive reaches the browser, and
 * it calls HaTi server-to-server, which means CORS never enters the picture.
 *
 * The page is behind a login — email and password, with reset by email. This
 * matters because the dashboard lists HaTi's file paths, its routes that work
 * without logging in, and its known weaknesses. Every route that reads or
 * changes anything requires a session; /api/auth/status and /api/health are
 * the only ones that answer without one, and neither returns any data.
 *
 * Environment:
 *   GITHUB_TOKEN         fine-grained PAT, read-only, scoped to the HaTi repo
 *   HATI_URL             base URL of the running HaTi instance
 *   MAPPER_TOKEN         bearer credential HaTi's /api/pulse requires
 *   MAPPER_OWNER_EMAIL   optional — restricts who may claim the account
 *   RESEND_API_KEY       optional — needed to email password resets
 *   ANTHROPIC_API_KEY    optional — the assistant's key is normally set in the
 *                        page instead, on the Settings panel
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
import { Accounts, validEmail, normaliseEmail, SESSION_DAYS } from './lib/accounts.mjs';
import { sendResetEmail, emailConfigured } from './lib/mail.mjs';
import { readFixture, FIXTURE_WARNING } from './lib/fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const REPO = process.env.HATI_REPO || 'youngmbg21-cmyk/mkataba-clm';
const REF = process.env.HATI_REF || 'main';
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const HATI_URL = (process.env.HATI_URL || '').trim().replace(/\/+$/, '');
const MAPPER_TOKEN = (process.env.MAPPER_TOKEN || '').trim();

/* Read HaTi's source from a directory instead of downloading it. Unset in
   normal running; the verification suite sets it when the real repository
   cannot be reached. See lib/fixture.mjs. */
const FIXTURE = (process.env.HATI_FIXTURE || '').trim();

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

/* -------------------------------------------------------------- accounts */

const accounts = new Accounts(DATA_DIR);
/* Restricts who may claim the account on a fresh install. With it set, only
   that address can register; without it, the first visitor claims it — which
   is why the setup page says to do it straight away. */
const OWNER_EMAIL = normaliseEmail(process.env.MAPPER_OWNER_EMAIL || '');

/* ---------------------------------------------------------- the AI brain */

/* The key is set from inside the platform, on the Settings panel, and stored
   on this server. An ANTHROPIC_API_KEY in the environment still works as a
   fallback for anyone who prefers it, but the key set in the page wins —
   the same precedence HaTi uses. This is safe because the page is behind a
   login: only the signed-in owner can read or change it. */
const ENV_AI_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const AI_MODEL = (process.env.ANTHROPIC_MODEL || '').trim() || DEFAULT_MODEL;
const KEY_FILE = path.join(DATA_DIR, 'ai-key.json');

let pastedKey = '';
try {
  pastedKey = (JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).key || '').trim();
} catch (_) { /* no key stored yet — normal */ }

const aiKey = () => pastedKey || ENV_AI_KEY;
const aiKeySource = () => (pastedKey ? 'platform' : (ENV_AI_KEY ? 'environment' : null));

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
   login already keeps strangers out; this is the second line, against the
   owner's own runaway loop or a session token that got away. Without it a
   single mistake could spend the owner's Anthropic credit all night. Resets at
   UTC midnight. */
const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT || 200);
let chatDay = '', chatCount = 0;
function chatBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== chatDay) { chatDay = today; chatCount = 0; }
  return { date: chatDay, used: chatCount, limit: CHAT_DAILY_LIMIT };
}

const app = express();
app.disable('x-powered-by');

/* One proxy sits in front of this service — Render's edge, which terminates
   TLS and appends the real caller to x-forwarded-for. Telling Express that is
   what makes req.ip trustworthy: with one hop trusted it takes the entry the
   proxy itself added and ignores anything the caller put in front of it, so a
   forged header cannot move a request into a fresh rate-limit bucket. Reading
   the header directly, as this used to, made the login limit bypassable by
   rotating a value the client controls. */
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ guard */

/* A small sliding-window limiter, same shape as HaTi's. The login is what
   keeps the dashboard private; this is what stops the routes in front of the
   login being hammered, and what bounds how many repository downloads one
   signed-in session can trigger. */
const hits = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const id = req.ip || 'unknown';
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

/* What this page is actually allowed to load. Written from what it does, not
   from a template: it fetches its own /api/*, runs one script of its own, uses
   inline style attributes throughout the markup, carries its icon as a data:
   URL, and asks Google for two fonts. Nothing else — so everything else is
   refused by default rather than merely unused.

   'unsafe-inline' is granted to styles only. The markup genuinely carries
   style="" attributes on generated rows, and there is no way to allow those
   without it. Scripts get no such grant: the one script is app.js, served from
   here, and an injected <script> or an inline handler cannot run. */
const CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* ------------------------------------------------------------ the login */

const COOKIE = 'mapper_session';

/* Secure cookies whenever the connection is actually https. Render terminates
   TLS at its edge and forwards x-forwarded-proto, so that header is what tells
   us — checking req.secure alone would never be true behind the proxy. */
const isHttps = req =>
  req.secure ||
  (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
  String(process.env.HTTPS || '').toLowerCase() === 'true';

function setSessionCookie(req, res, token) {
  const bits = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (isHttps(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(req, res) {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function sessionToken(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  return hit ? hit.slice(COOKIE.length + 1) : null;
}

/* Every route that reads or changes anything sits behind this. */
function requireAuth(req, res, next) {
  const token = sessionToken(req);
  const session = accounts.sessionFor(token);
  if (!session) return res.status(401).json({ error: 'Sign in to see this.', needsAuth: true });
  req.sessionToken = token;
  next();
}

/* Express derives this from the socket and the one trusted proxy hop, so it is
   the same value the limiter buckets on and cannot be set by the caller. */
const clientIp = req => req.ip || null;

/* ------------------------------------------------------------ /api/auth/* */

/* What the page needs before it can show anything: is there an owner yet, and
   am I signed in? Deliberately the only route that answers without a session. */
app.get('/api/auth/status', rateLimit('authstatus', 240, 15 * 60 * 1000), (req, res) => {
  res.json({
    claimed: accounts.claimed,
    signedIn: !!accounts.sessionFor(sessionToken(req)),
    email: accounts.sessionFor(sessionToken(req)) ? accounts.ownerEmail : null,
    expectsEmail: OWNER_EMAIL || null,
    canEmailResets: emailConfigured(),
    durable: accounts.durable,
  });
});

/* Claim the account. Only possible once. */
app.post('/api/auth/setup', rateLimit('authsetup', 10, 15 * 60 * 1000), (req, res) => {
  const { email, password } = req.body || {};
  const result = accounts.register(email, password, OWNER_EMAIL);
  if (result.error) return res.status(400).json({ error: result.error });
  const token = accounts.createSession({ ip: clientIp(req), agent: req.get('user-agent') });
  setSessionCookie(req, res, token);
  console.log(`[auth] the account was claimed by ${result.email}.`);
  res.json({ ok: true, email: result.email });
});

/* Sign in. The failure is the same whether the email or the password was
   wrong, so this cannot be used to find out which addresses exist. */
app.post('/api/auth/login', rateLimit('authlogin', 12, 15 * 60 * 1000), (req, res) => {
  const { email, password } = req.body || {};
  if (!accounts.claimed) return res.status(400).json({ error: 'This Mapper has no account yet.' });

  /* The per-address limit above stops one machine guessing fast. This stops
     the same guessing spread across many addresses, because the count belongs
     to the account rather than to the caller. */
  const blocked = accounts.loginBlock();
  if (blocked) {
    console.warn(`[auth] sign-in refused from ${clientIp(req) || 'unknown'}: the account is locked after ${accounts.loginFailures} wrong passwords.`);
    return res.status(429).json({ error: blocked, lockedOut: true });
  }

  if (!accounts.verify(email, password)) {
    const left = accounts.noteFailedLogin();
    console.warn(`[auth] failed sign-in attempt from ${clientIp(req) || 'unknown'}; ${left} left before the account locks.`);
    return res.status(401).json({ error: 'That email and password do not match.' });
  }
  accounts.noteSuccessfulLogin();
  const token = accounts.createSession({ ip: clientIp(req), agent: req.get('user-agent') });
  setSessionCookie(req, res, token);
  console.log(`[auth] signed in from ${clientIp(req) || 'unknown'}.`);
  res.json({ ok: true, email: accounts.ownerEmail });
});

app.post('/api/auth/logout', (req, res) => {
  const token = sessionToken(req);
  if (token) accounts.endSession(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

/* Ask for a reset link. Always answers the same way, whether or not the
   address is the owner's — otherwise this route would confirm the email. */
app.post('/api/auth/forgot', rateLimit('authforgot', 6, 15 * 60 * 1000), async (req, res) => {
  const email = normaliseEmail((req.body || {}).email);
  if (!validEmail(email)) return res.status(400).json({ error: 'That does not look like an email address.' });

  const started = accounts.startReset(email);
  if (started) {
    const proto = isHttps(req) ? 'https' : 'http';
    const link = `${proto}://${req.get('host')}/#reset=${started.fragment}`;
    await sendResetEmail(email, link, started.minutes);
  } else {
    console.warn(`[auth] a reset was requested for an address that is not the owner's, from ${clientIp(req) || 'unknown'}.`);
  }

  res.json({
    ok: true,
    emailSent: emailConfigured(),
    note: emailConfigured()
      ? 'If that address belongs to this Mapper, a reset link is on its way. It expires in 30 minutes.'
      : 'No email provider is configured on this service, so the reset link has been written to the service log instead. Open the Logs tab in your hosting dashboard to find it.',
  });
});

/* Finish a reset. Signs every device out, including whoever asked. */
app.post('/api/auth/reset', rateLimit('authreset', 10, 15 * 60 * 1000), (req, res) => {
  const { token, password } = req.body || {};
  const result = accounts.completeReset(token, password);
  if (result.error) return res.status(400).json({ error: result.error });
  clearSessionCookie(req, res);
  console.log('[auth] the password was reset; every session was signed out.');
  res.json({ ok: true });
});

/* Change the password from inside, knowing the current one. */
app.post('/api/auth/change-password', requireAuth, rateLimit('authchange', 10, 15 * 60 * 1000), (req, res) => {
  const { current, password } = req.body || {};
  const result = accounts.changePassword(current, password);
  if (result.error) return res.status(400).json({ error: result.error });
  // Keep this device signed in; drop the rest.
  const keep = req.sessionToken;
  accounts.endAllSessions();
  const token = accounts.createSession({ ip: clientIp(req), agent: req.get('user-agent') });
  setSessionCookie(req, res, token);
  console.log('[auth] the password was changed; other sessions were signed out.');
  res.json({ ok: true, keptThisDevice: !!keep });
});

app.post('/api/auth/sign-out-everywhere', requireAuth, (req, res) => {
  accounts.endAllSessions();
  clearSessionCookie(req, res);
  console.log('[auth] every session was signed out on request.');
  res.json({ ok: true });
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

  let files, commits = null, commitError = null, requests = 0;
  if (FIXTURE) {
    const fx = readFixture(FIXTURE);
    files = fx.files;
    commits = fx.commits;
  } else {
    const client = makeClient(GITHUB_TOKEN);
    files = await fetchRepoFiles(client, REPO, REF);

    // Commit history is best-effort: the seven code-derived panels do not need
    // it, so a commits failure must not take the whole scan down with it.
    try {
      commits = await fetchCommits(client, REPO, REF, COMMIT_COUNT);
    } catch (e) {
      commitError = e.message;
    }
    requests = client.requests;
  }

  const payload = buildScan({ files, commits, repo: REPO, ref: REF, requestCount: requests });
  payload.tookMs = Date.now() - started;
  payload.tokenConfigured = !!GITHUB_TOKEN;
  payload.fixture = !!FIXTURE;
  if (FIXTURE) payload.warnings.push(FIXTURE_WARNING);
  if (commitError) payload.warnings.push(`Commit history could not be read: ${commitError}`);
  if (!FIXTURE && !GITHUB_TOKEN) payload.warnings.push('GITHUB_TOKEN is not set — GitHub allows only 60 unauthenticated requests an hour, so scans will start failing.');

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

app.get('/api/scan', requireAuth, rateLimit('scan', 60, 15 * 60 * 1000), async (req, res) => {
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

app.get('/api/pulse', requireAuth, rateLimit('pulse', 120, 15 * 60 * 1000), async (req, res) => {
  res.json(await readPulse());
});

/* ------------------------------------------------------------ /api/changes */

/* The Mapper's own watch log: what has actually moved in the last 72 hours,
   already written in plain English by lib/history.mjs. */
app.get('/api/changes', requireAuth, rateLimit('changes', 120, 15 * 60 * 1000), (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), 72);
  res.json({ ...history.status(), hours, rounds: history.changes(hours) });
});

/* --------------------------------------------------------- /api/ai/config */

/* What the page needs to know about the brain — never the key itself. The
   hint is the last four characters, which is enough to tell two keys apart
   and not enough to be one. */
app.get('/api/ai/config', requireAuth, rateLimit('aiconfig', 120, 15 * 60 * 1000), (req, res) => {
  const k = aiKey();
  res.json({
    configured: !!k,
    source: aiKeySource(),
    hint: k ? '••••' + k.slice(-4) : '',
    model: AI_MODEL,
    // A key can still be supplied by the environment as a fallback; the page
    // says which one is in use so there is never any doubt.
    environmentFallback: !!ENV_AI_KEY,
    budget: chatBudget(),
    storageIsDurable: history.status().durable,
  });
});

/* Set or clear the key from inside the platform. Behind the login, so only the
   signed-in owner can do this. A key set here takes precedence over anything
   in the environment. */
app.put('/api/ai/config', requireAuth, rateLimit('aiconfigw', 20, 15 * 60 * 1000), (req, res) => {
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
  res.json({ configured: true, source: 'platform', hint: '••••' + key.slice(-4), durable });
});

/* --------------------------------------------------------------- /api/chat */

/* The assistant. Same tool loop as HaTi's Copilot: the model fetches what it
   needs, then calls deliver_answer exactly once. It reads only the scan, the
   change log and the live caps — the same things the dashboard shows — so it
   has no route to HaTi's contract data even if asked. */
app.post('/api/chat', requireAuth, rateLimit('chat', 40, 15 * 60 * 1000), async (req, res) => {
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
