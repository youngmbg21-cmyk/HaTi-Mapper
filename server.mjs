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
import { History, MAX_HISTORY_HOURS, snapshot } from './lib/history.mjs';
import { CHAT_TOOLS, buildSystem, runTool, normalizeAnswer } from './lib/chat.mjs';
import { messages as anthropicMessages, friendlyError, DEFAULT_MODEL } from './lib/anthropic.mjs';
import { Accounts, validEmail, normaliseEmail, SESSION_DAYS } from './lib/accounts.mjs';
import { sendResetEmail, sendDigestEmail, sendAlertEmail, emailConfigured } from './lib/mail.mjs';
import { Prefs } from './lib/prefs.mjs';
import { buildDigest, digestText } from './lib/digest.mjs';
import { evaluateWatch, describeRules, RULES } from './lib/watch.mjs';
import { readFixture, FIXTURE_WARNING } from './lib/fixture.mjs';
import { driftVerdict } from './lib/drift.mjs';
import { describeFinding, draftInstruction } from './lib/draft.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const REPO = process.env.HATI_REPO || 'youngmbg21-cmyk/mkataba-clm';
const REF = process.env.HATI_REF || 'main';
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const HATI_URL = (process.env.HATI_URL || '').trim().replace(/\/+$/, '');
const MAPPER_TOKEN = (process.env.MAPPER_TOKEN || '').trim();
/* Optional. Only ever used to put a link to this dashboard at the bottom of an
   email the owner asked for. */
const PUBLIC_URL = (process.env.MAPPER_URL || '').trim().replace(/\/+$/, '');

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

/* Where the change log, its archive, the day's question count and any pasted
   AI key are kept. On Render this survives restarts but not a redeploy unless a
   disk is attached — the README says so, and every one of them degrades to
   memory rather than failing.

   Deliberately NOT `data/`: that directory holds the hand-maintained
   dependency map and phrasebook, which are source, not runtime state. Mixing
   generated files in with them invites exactly the accident of deleting one
   while clearing the other. */
const DATA_DIR = process.env.MAPPER_DATA || path.join(__dirname, '.mapper-state');
const history = new History(DATA_DIR);
const prefs = new Prefs(DATA_DIR);

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

/* The count is kept on disk, next to the account and the change log. Held in
   memory it reset every time the service restarted — which on Render's free
   tier is after every idle period — so the ceiling it was supposed to be never
   really applied. Same pattern the account uses: if the directory cannot be
   written, say so once and carry on in memory rather than failing. */
const BUDGET_FILE = path.join(DATA_DIR, 'chat-budget.json');
let chatDay = '', chatCount = 0, budgetWritable = true;
try {
  const raw = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  chatDay = String(raw.date || '');
  chatCount = Number(raw.used) || 0;
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[chat] the daily question count could not be read:', e.message);
}

function saveBudget() {
  if (!budgetWritable) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({ date: chatDay, used: chatCount }));
  } catch (e) {
    budgetWritable = false;
    console.warn('[chat] the daily question count cannot be written to disk, so it will reset when this service restarts:', e.message);
  }
}

function chatBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== chatDay) { chatDay = today; chatCount = 0; saveBudget(); }
  return { date: chatDay, used: chatCount, limit: CHAT_DAILY_LIMIT, durable: budgetWritable };
}

/* Called once a question has actually been answered. Counting before the call
   meant a run of Anthropic outages could eat the whole day's allowance without
   the owner getting a single answer for it. */
function countAnsweredQuestion() {
  chatBudget();                 // rolls the day over first, if it has changed
  chatCount++;
  saveBudget();
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
     written to the log. Scans that find nothing changed add nothing, so the
     log stays a list of real events rather than a list of look-ups.

     The tripwires are evaluated against the same pair of snapshots, before the
     new one replaces the old, and anything they catch is written into the log
     as a high-weight event alongside the derived ones. */
  try {
    const prevSnap = history.latestSnapshot();
    const nextSnap = snapshot(payload);

    // Only rule (c) needs a running HaTi, and it is the only reason to ask.
    let pulse = null;
    if (prefs.get('watch')?.aiRequests?.on) {
      pulse = await readPulse().catch(() => null);
    }

    const trips = evaluateWatch({ prev: prevSnap, next: nextSnap, pulse, rules: prefs.get('watch') });
    const fresh = recordTrips(trips);

    const events = history.record(payload, fresh.map(t => ({ weight: 3, kind: 'watch', text: t.text })));
    if (events.length) console.log(`[history] ${events.length} change(s) noticed in this scan.`);
    if (fresh.length) {
      console.warn(`[watch] ${fresh.length} rule(s) tripped: ${fresh.map(t => t.rule).join(', ')}.`);
      alertOnTrips(fresh).catch(e => console.warn('[watch] the alert could not be sent:', e.message));
    }
  } catch (e) {
    console.warn('[history] could not record this scan:', e.message);
  }
  payload.history = history.status();
  /* How the "Not finished" list has moved lately. Derived here rather than in
     the scanner, because it is the one thing on that panel that comes from the
     archive rather than from HaTi's source. */
  payload.gapMovement = history.gapMovement(30);
  payload.tripped = prefs.get('tripped') || [];
  return payload;
}

/* Keep the trips that are new. A rule that has already raised a banner and not
   been dismissed must not raise it again on the next scan ten minutes later —
   that is how a warning becomes wallpaper. */
function recordTrips(trips) {
  const standing = prefs.get('tripped') || [];
  const known = new Set(standing.map(t => t.key));
  const fresh = trips.filter(t => !known.has(t.key));
  if (!fresh.length) return [];
  prefs.update({ tripped: [...standing, ...fresh].slice(-40) });
  return fresh;
}

/* ------------------------------------------------- when the scan keeps failing */

/* A monitoring tool that stops being able to monitor, silently, is worse than
   no monitoring tool: the page still shows the last good scan, so everything
   looks fine. Three failures in a row is the point at which this stops being
   a blip — a spun-down GitHub, a network hiccup — and starts being something
   the owner has to do about. */
const SCAN_FAILURES_BEFORE_ALERT = 3;

function noteScanFailure(reason) {
  const failed = (prefs.get('failedScans') || 0) + 1;
  prefs.update({
    failedScans: failed,
    failedSince: prefs.get('failedSince') || new Date().toISOString(),
    failedReason: String(reason || '').slice(0, 300),
  });
  console.warn(`[scan] failure ${failed} in a row.`);
  if (failed >= SCAN_FAILURES_BEFORE_ALERT) {
    alertScanFailure().catch(e => console.warn('[scan] the alert could not be sent:', e.message));
  }
}

function noteScanSuccess() {
  if (!prefs.get('failedScans') && !prefs.get('scanAlertSent')) return;
  console.log('[scan] reading HaTi is working again.');
  prefs.update({ failedScans: 0, failedSince: null, failedReason: null, scanAlertSent: false });
}

/* Exactly one alert per outage. Marked as sent before the attempt, so a
   provider that is itself down cannot turn this into one email every ten
   minutes for as long as the outage lasts. */
async function alertScanFailure() {
  if (prefs.get('scanAlertSent')) return;
  if (!emailConfigured() || !accounts.ownerEmail) return;   // the banner says it instead
  prefs.update({ scanAlertSent: true });
  const since = prefs.get('failedSince');
  await sendAlertEmail(
    accounts.ownerEmail,
    'HaTi Mapper — it cannot read HaTi\'s code',
    [
      `The Mapper hasn't been able to read HaTi's code since ${since ? new Date(since).toUTCString() : 'a short while ago'}.`,
      '',
      `Reason: ${prefs.get('failedReason') || 'not recorded'}`,
      '',
      'Until this clears, the dashboard is showing the last scan that worked, so it will look',
      'correct while quietly describing older code. Nothing is wrong with HaTi itself as far as',
      'the Mapper can tell — this is about the Mapper reaching GitHub.',
      '',
      'You will not get another of these until a scan succeeds again.',
      PUBLIC_URL ? 'The dashboard: ' + PUBLIC_URL : '',
    ].filter(Boolean).join('\n'));
}

function scanTrouble() {
  const failed = prefs.get('failedScans') || 0;
  if (failed < SCAN_FAILURES_BEFORE_ALERT) return null;
  return {
    failedScans: failed,
    since: prefs.get('failedSince'),
    reason: prefs.get('failedReason'),
    emailed: !!prefs.get('scanAlertSent'),
  };
}

/* Rule (a) is the one that should not wait until morning. The rest ride along
   in the next day's summary, which they do automatically by being in the log. */
async function alertOnTrips(fresh) {
  const urgent = fresh.filter(t => t.immediate);
  if (!urgent.length) return;
  if (!prefs.get('digestEmail') || !emailConfigured() || !accounts.ownerEmail) return;
  await sendAlertEmail(
    accounts.ownerEmail,
    'HaTi — something opened that needs no login',
    [
      'One of the tripwires you set on the Mapper has gone off.',
      '',
      ...urgent.map(t => '- ' + t.text),
      '',
      'This is not waiting for the morning summary because of what it is.',
      PUBLIC_URL ? 'The dashboard: ' + PUBLIC_URL : '',
      '',
      'Turn these off in the Mapper\'s Settings if you no longer want them.',
    ].filter(Boolean).join('\n'));
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
    noteScanSuccess();
    /* The morning summary rides on the first scan of the day rather than on a
       timer, because a scan is when there is something new to summarise. It
       never blocks the response. */
    maybeEmailDigest().catch(e => console.warn('[digest] could not be sent:', e.message));
    res.json({ ...payload, cached: false, cacheAgeMs: 0 });
  } catch (e) {
    console.error('[scan] failed:', e.message);
    noteScanFailure(e.message);
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

/* The drift verdict is answered here rather than on /api/scan because it takes
   both hashes to work out, and only this route has been anywhere near a
   running HaTi. The scan carries its own hash, as it always has. */
app.get('/api/pulse', requireAuth, rateLimit('pulse', 120, 15 * 60 * 1000), async (req, res) => {
  const pulse = await readPulse();
  res.json({
    ...pulse,
    scannedCommit: cache?.payload?.commit || null,
    drift: driftVerdict(cache?.payload, pulse),
  });
});

/* ------------------------------------------------------------ /api/changes */

/* The Mapper's own watch log: what has actually moved, already written in
   plain English by lib/history.mjs. Seventy-two hours is the default view;
   anything longer is served from the archive, up to 90 days. */
app.get('/api/changes', requireAuth, rateLimit('changes', 120, 15 * 60 * 1000), (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 72, 1), MAX_HISTORY_HOURS);
  res.json({ ...history.status(), hours, rounds: history.changes(hours) });
});

/* ------------------------------------------------------------- /api/trends */

/* The measurement series behind the sparklines: numbers only, no names and no
   paths, straight out of the archive. */
app.get('/api/trends', requireAuth, rateLimit('trends', 120, 15 * 60 * 1000), (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), Math.floor(MAX_HISTORY_HOURS / 24));
  const points = history.points(days * 24);
  res.json({
    days,
    points,
    // Below three readings a line says more than it knows, so the page draws
    // nothing and says why instead.
    enough: points.length >= 3,
    watchedSince: history.status().since,
  });
});

/* -------------------------------------------------------- /api/preferences */

/* The handful of choices the owner makes on the Settings tab. Nothing secret
   crosses this route — no key, no address, no token. */
app.get('/api/preferences', requireAuth, rateLimit('prefs', 120, 15 * 60 * 1000), (req, res) => {
  const all = prefs.all();
  res.json({
    digestEmail: all.digestEmail,
    lastDigestDate: all.lastDigestDate,
    canEmail: emailConfigured(),
    durable: prefs.durable,
  });
});

app.put('/api/preferences', requireAuth, rateLimit('prefsw', 40, 15 * 60 * 1000), (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.digestEmail === 'boolean') patch.digestEmail = body.digestEmail;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
  prefs.update(patch);
  console.log(`[prefs] morning summaries are now ${prefs.get('digestEmail') ? 'on' : 'off'}.`);
  res.json({ digestEmail: prefs.get('digestEmail'), canEmail: emailConfigured(), durable: prefs.durable });
});

/* -------------------------------------------------------------- /api/watch */

/* The tripwires, and whatever they have caught that has not been dismissed. */
app.get('/api/watch', requireAuth, rateLimit('watch', 120, 15 * 60 * 1000), (req, res) => {
  res.json({
    rules: describeRules(prefs.get('watch')),
    tripped: prefs.get('tripped') || [],
    // Not a rule the owner set — the Mapper reporting on itself. Kept on this
    // route because it is the one the page asks for "anything I should know?".
    scanTrouble: scanTrouble(),
    canWatchLiveUsage: !!(HATI_URL && MAPPER_TOKEN),
    durable: prefs.durable,
  });
});

app.put('/api/watch', requireAuth, rateLimit('watchw', 60, 15 * 60 * 1000), (req, res) => {
  const { name, on, threshold } = req.body || {};
  if (!RULES[name]) return res.status(400).json({ error: 'There is no rule by that name.' });
  prefs.setRule(name, { on, threshold });
  console.log(`[watch] "${name}" is now ${prefs.get('watch')[name].on ? 'on' : 'off'}.`);
  res.json({ rules: describeRules(prefs.get('watch')), tripped: prefs.get('tripped') || [] });
});

/* Dismissing clears the banner and lets the rule fire again next time. */
app.post('/api/watch/dismiss', requireAuth, rateLimit('watchd', 60, 15 * 60 * 1000), (req, res) => {
  const key = (req.body || {}).key;
  const standing = prefs.get('tripped') || [];
  const left = key ? standing.filter(t => t.key !== key) : [];
  prefs.update({ tripped: left });
  res.json({ tripped: left });
});

/* ------------------------------------------------------------- /api/digest */

/* "What did last night's session do?" — the change log grouped into one report
   instead of a stream of individual events. Derived entirely from the log and
   the cached scan; it reads nothing new. */
app.get('/api/digest', requireAuth, rateLimit('digest', 120, 15 * 60 * 1000), (req, res) => {
  const period = ['midnight', '24h', '72h'].includes(req.query.period) ? req.query.period : 'midnight';
  res.json(currentDigest(period));
});

function currentDigest(period = 'midnight') {
  return buildDigest({
    rounds: history.changes(72),
    points: history.points(72),
    scan: cache?.payload || null,
    period,
  });
}

/* The email path. Once a day, on the first scan after 06:00 local time, if the
   owner asked for it and a provider is configured. Everything about it is
   optional: with no key, or the preference off, the same report is simply on
   the dashboard and nothing is sent. */
async function maybeEmailDigest() {
  if (!prefs.get('digestEmail') || !emailConfigured()) return { sent: false, reason: 'not-configured' };
  if (!accounts.ownerEmail) return { sent: false, reason: 'no-owner' };

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (now.getHours() < 6) return { sent: false, reason: 'too-early' };
  if (prefs.get('lastDigestDate') === today) return { sent: false, reason: 'already-sent-today' };

  const digest = currentDigest('midnight');
  // Marked as sent before the attempt, so a provider that is refusing cannot
  // turn into one email per scan for the rest of the day.
  prefs.update({ lastDigestDate: today });
  const result = await sendDigestEmail(
    accounts.ownerEmail,
    digest.quiet ? 'HaTi — nothing moved overnight' : 'HaTi — what changed overnight',
    digestText(digest, { link: PUBLIC_URL || undefined }));
  return result;
}

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

  /* The assistant answers from the cached scan. It never triggers a fresh
     repository download — asking a question should not cost a scan. */
  if (!cache) {
    return res.status(409).json({ error: 'The platform has not been scanned yet, so there is nothing for me to read. Let the page finish loading, then ask again.' });
  }
  const scan = cache.payload;

  /* "Draft a fix prompt" on a finding. The instruction is built here, from the
     scan, so the paths and identifiers in it are the ones that were actually
     scanned rather than anything typed or remembered. Same key, same budget,
     same rate limit, same loop — there is no second way to reach Anthropic. */
  const draftReq = req.body?.draft;
  let convo;
  if (draftReq && typeof draftReq.kind === 'string') {
    const finding = describeFinding(scan, draftReq.kind, String(draftReq.id || ''));
    if (finding.error) return res.status(404).json({ error: finding.error });
    convo = [{ role: 'user', content: draftInstruction(scan, finding) }];
  } else {
    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    convo = incoming
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!convo.length || convo[convo.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'The last message needs to be a question from you.' });
    }
  }

  let pulse = null;
  try { pulse = await readPulse(); } catch (_) { pulse = { available: false }; }

  const system = buildSystem({ scan, historyStatus: history.status(), pulse, draft: !!draftReq });
  const working = convo.slice();
  const ctx = { scan, history, pulse };
  let final = null, usedModel = AI_MODEL, toolsUsed = [];

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
    /* Anthropic answered, so this one counts. Anything that returned above —
       a rejected key, a rate limit, an outage — did not. */
    countAnsweredQuestion();
    res.json({ ...final, model: usedModel, toolsUsed, budget: chatBudget(), drafted: !!draftReq });
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
