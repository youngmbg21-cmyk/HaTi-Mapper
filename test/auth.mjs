/* HaTi-Mapper — the login, tested end to end.
 *
 * Covers the whole life of the account: claiming it, signing in, being turned
 * away, resetting a forgotten password by link, changing it from inside, and
 * signing out. Also asserts the thing that matters most — that none of the
 * data routes answer without a session.
 *
 *   node test/auth.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';
import { driftVerdict } from '../lib/drift.mjs';
import { History, snapshot } from '../lib/history.mjs';
import { buildScan } from '../lib/scan.mjs';
import { readFixture } from '../lib/fixture.mjs';
import { buildDigest, digestText } from '../lib/digest.mjs';
import { FIXTURE_DIR } from './source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.AUTH_PORT || 4450);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-auth-data');
const OWNER = 'owner@example.com';
const PW = 'firstpass1';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

/* A tiny cookie jar, so the test behaves like a browser. */
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.get('set-cookie');
  if (setC) {
    const pair = setC.split(';')[0];
    cookie = /=;?$/.test(pair) || /=$/.test(pair) ? '' : pair;
  }
  let parsed = null;
  const raw = await res.text();
  try { parsed = JSON.parse(raw); } catch (_) {}
  return { status: res.status, body: parsed, raw, setCookie: setC };
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b || {});

fs.rmSync(DATA, { recursive: true, force: true });

const source = await hatiSource();
announce(source);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), MAPPER_DATA: DATA, MAPPER_OWNER_EMAIL: OWNER,
    HATI_URL: '', MAPPER_TOKEN: '', RESEND_API_KEY: '', ...source.env,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const PROTECTED = ['/api/scan', '/api/pulse', '/api/changes', '/api/ai/config'];

/* A second Mapper, behind a stand-in proxy, for the checks that need a fresh
   set of rate-limit buckets or a caller that appears to come from elsewhere. */
const SPOOF_PORT = PORT + 1;
const PROXY_PORT = PORT + 2;
const SPOOF_DATA = path.join(ROOT, '.tmp-auth-data-2');
let spoofServer = null, spoofProxy = null;

/* ---------------------------------------------------------------- a proxy */

/* A stand-in for the edge Render puts in front of this service. A real reverse
   proxy APPENDS its own view of the caller to x-forwarded-for, leaving
   anything the caller wrote there in front of it — which is exactly why the
   first entry in that header is worthless as an identity and the last one is
   not. This behaves the same way, so the limiter can be tested honestly.
   `x-test-source` lets a test say which address the proxy should claim. */
function startProxy(port, upstreamPort) {
  const srv = http.createServer((req, res) => {
    const headers = { ...req.headers };
    const source = headers['x-test-source'] || '127.0.0.1';
    delete headers['x-test-source'];
    headers['x-forwarded-for'] = (headers['x-forwarded-for'] ? headers['x-forwarded-for'] + ', ' : '') + source;
    headers.host = '127.0.0.1:' + upstreamPort;
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, r => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message })); });
    req.pipe(up);
  });
  return new Promise((resolve, reject) => srv.listen(port, () => resolve(srv)).on('error', reject));
}

function startMapper(port, dataDir, extra, keepState) {
  if (!keepState) fs.rmSync(dataDir, { recursive: true, force: true });
  return spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), MAPPER_DATA: dataDir,
      HATI_URL: '', MAPPER_TOKEN: '', RESEND_API_KEY: '', ...source.env, ...(extra || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitFor(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  console.log('\nHaTi-Mapper — the login\n');

  /* ---- nothing is readable before there is an account ---- */
  console.log('Locked by default');
  for (const p of PROTECTED) {
    const r = await get(p);
    check(`${p} refuses without a session`, r.status === 401, `got ${r.status}`);
  }
  const chatClosed = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
  check('/api/chat refuses without a session', chatClosed.status === 401, `got ${chatClosed.status}`);
  const keyClosed = await call('PUT', '/api/ai/config', { key: 'sk-ant-' + 'x'.repeat(30) });
  check('The AI key cannot be set without a session', keyClosed.status === 401, `got ${keyClosed.status}`);

  const status0 = await get('/api/auth/status');
  check('The status route answers without a session', status0.status === 200);
  check('It reports the account is unclaimed', status0.body.claimed === false);
  check('It reports which email is expected', status0.body.expectsEmail === OWNER, status0.body.expectsEmail);
  check('The status route leaks no data', !('screens' in (status0.body || {})));

  /* ---- claiming the account ---- */
  console.log('\nClaiming the account');
  const wrongEmail = await post('/api/auth/setup', { email: 'someone@else.com', password: PW });
  check('Only the expected email may claim it', wrongEmail.status === 400, JSON.stringify(wrongEmail.body));
  const weak = await post('/api/auth/setup', { email: OWNER, password: 'short' });
  check('A weak password is refused', weak.status === 400, weak.body?.error);
  const noDigit = await post('/api/auth/setup', { email: OWNER, password: 'allletters' });
  check('A password with no number is refused', noDigit.status === 400, noDigit.body?.error);

  const setup = await post('/api/auth/setup', { email: OWNER, password: PW });
  check('The account is created', setup.status === 200 && setup.body.ok === true, JSON.stringify(setup.body));
  check('A session cookie comes back', /mapper_session=/.test(setup.setCookie || ''), setup.setCookie);
  check('The cookie is HttpOnly', /HttpOnly/i.test(setup.setCookie || ''));
  check('The cookie is SameSite=Lax', /SameSite=Lax/i.test(setup.setCookie || ''));

  const twice = await post('/api/auth/setup', { email: OWNER, password: PW });
  check('It cannot be claimed twice', twice.status === 400, JSON.stringify(twice.body));

  /* ---- signed in, everything opens ---- */
  console.log('\nSigned in');
  for (const p of PROTECTED) {
    const r = await get(p);
    check(`${p} answers with a session`, r.status === 200, `got ${r.status}`);
  }
  const cfg = await get('/api/ai/config');
  check('The AI key can now be set from the platform', cfg.body.environmentFallback === false, JSON.stringify(cfg.body));
  const setKey = await call('PUT', '/api/ai/config', { key: 'sk-ant-' + 'a'.repeat(40) });
  check('A key saves from inside the platform', setKey.status === 200 && setKey.body.configured === true, JSON.stringify(setKey.body));
  const cfg2 = await get('/api/ai/config');
  check('The key is reported as set in the platform', cfg2.body.source === 'platform', cfg2.body.source);
  check('The key itself is never returned', !JSON.stringify(cfg2.body).includes('aaaaaaaa'), JSON.stringify(cfg2.body));

  /* ---- signing out ---- */
  console.log('\nSigning out and back in');
  const out = await post('/api/auth/logout');
  check('Signing out succeeds', out.status === 200);
  const afterOut = await get('/api/scan');
  check('The data closes again after signing out', afterOut.status === 401, `got ${afterOut.status}`);

  const badPw = await post('/api/auth/login', { email: OWNER, password: 'wrongpass1' });
  check('A wrong password is refused', badPw.status === 401, JSON.stringify(badPw.body));
  const badEmail = await post('/api/auth/login', { email: 'nobody@example.com', password: PW });
  check('A wrong email is refused', badEmail.status === 401);
  check('Both failures read the same, so neither confirms the email',
    badPw.body.error === badEmail.body.error, `${badPw.body.error} / ${badEmail.body.error}`);

  const good = await post('/api/auth/login', { email: OWNER, password: PW });
  check('The right password signs in', good.status === 200 && good.body.ok === true);
  check('The data opens again', (await get('/api/scan')).status === 200);

  /* ---- forgotten password ---- */
  console.log('\nResetting a forgotten password');
  log = '';
  const forgot = await post('/api/auth/forgot', { email: OWNER });
  check('A reset can be requested', forgot.status === 200 && forgot.body.ok === true, JSON.stringify(forgot.body));
  check('It says the link went to the log, since no email provider is set',
    forgot.body.emailSent === false && /service log/i.test(forgot.body.note || ''), forgot.body.note);

  const stranger = await post('/api/auth/forgot', { email: 'stranger@example.com' });
  check('An unknown address gets the identical answer', stranger.status === 200 && stranger.body.ok === true);
  check('So the route cannot be used to discover the email',
    JSON.stringify(stranger.body) === JSON.stringify(forgot.body));

  await new Promise(r => setTimeout(r, 200));
  const linkMatch = log.match(/#reset=([A-Za-z0-9_.]+)/);
  check('The reset link is recoverable from the service log', !!linkMatch, (log.match(/\[auth\][^\n]*/g) || []).slice(0, 2).join(' | '));
  const resetToken = linkMatch ? linkMatch[1] : '';

  const badToken = await post('/api/auth/reset', { token: 'r_zzzzzz.deadbeef', password: 'secondpass2' });
  check('A forged reset link is refused', badToken.status === 400, JSON.stringify(badToken.body));

  const NEWPW = 'secondpass2';
  const doneReset = await post('/api/auth/reset', { token: resetToken, password: NEWPW });
  check('The real reset link works', doneReset.status === 200 && doneReset.body.ok === true, JSON.stringify(doneReset.body));

  const reused = await post('/api/auth/reset', { token: resetToken, password: 'thirdpass3' });
  check('A reset link cannot be used twice', reused.status === 400, JSON.stringify(reused.body));

  cookie = '';
  check('The old password no longer works', (await post('/api/auth/login', { email: OWNER, password: PW })).status === 401);
  const newLogin = await post('/api/auth/login', { email: OWNER, password: NEWPW });
  check('The new password works', newLogin.status === 200, JSON.stringify(newLogin.body));

  /* ---- changing the password from inside ---- */
  console.log('\nChanging the password from inside');
  const wrongCurrent = await post('/api/auth/change-password', { current: 'nope12345', password: 'fourthpass4' });
  check('The current password must be right', wrongCurrent.status === 400, JSON.stringify(wrongCurrent.body));
  const changed = await post('/api/auth/change-password', { current: NEWPW, password: 'fourthpass4' });
  check('The password changes', changed.status === 200, JSON.stringify(changed.body));
  check('This device stays signed in', (await get('/api/scan')).status === 200);
  cookie = '';
  check('The changed password is the one that works',
    (await post('/api/auth/login', { email: OWNER, password: 'fourthpass4' })).status === 200);

  /* ---- the account survives a restart ---- */
  console.log('\nDurability');
  check('The account was written to disk', fs.existsSync(path.join(DATA, 'account.json')));
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'account.json'), 'utf8'));
  check('The password is stored hashed, never in the clear',
    !JSON.stringify(onDisk).includes('fourthpass4') && !!onDisk.owner.hash && !!onDisk.owner.salt);
  check('Reset tokens are stored hashed too',
    (onDisk.resets || []).every(r => !!r.tokenHash && !('token' in r)));

  /* ---- a forged x-forwarded-for cannot buy a fresh rate-limit bucket ----
     The limiter used to key on the FIRST entry of x-forwarded-for, which is
     the one entry the caller controls, so rotating it reset the bucket and the
     login limit of 12 in 15 minutes could be walked straight past. It now keys
     on req.ip, which Express derives from the socket and the one trusted proxy
     hop. Proved through a stand-in proxy, because without one in front there
     is no honest way to tell a forged header from a real one. */
  console.log('\nA forged x-forwarded-for cannot reset the limit');
  /* A short lock window, so the "and it lets you back in afterwards" half of
     the account-backoff check below can actually be waited out. */
  spoofServer = startMapper(SPOOF_PORT, SPOOF_DATA, { LOGIN_LOCK_MINUTES: '0.2' });
  spoofProxy = await startProxy(PROXY_PORT, SPOOF_PORT);
  const proxyBase = `http://127.0.0.1:${PROXY_PORT}`;
  check('A second Mapper started behind a stand-in proxy', await waitFor(proxyBase));

  /* /api/auth/reset is the cheapest bucket to prove this on: 10 in 15 minutes,
     no account needed, no side effect — a bad token is simply refused. */
  const forged = [];
  const early = [];
  let lastSpoof = null;
  for (let i = 0; i < 11; i++) {
    const spoof = `198.51.100.${i + 1}`;
    forged.push(spoof);
    lastSpoof = await fetch(`${proxyBase}/api/auth/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': spoof },
      body: JSON.stringify({ token: 'r_zzzzzz.deadbeef', password: 'nevermind1' }),
    });
    if (i < 10) early.push(lastSpoof.status);
  }
  check('Every attempt carried a different forged address', new Set(forged).size === 11, forged.slice(0, 3).join(', ') + ' …');
  check('The first ten are answered on their merits', early.every(s => s === 400), early.join(','));
  check('The eleventh lands in the same bucket and is refused', lastSpoof.status === 429, `got ${lastSpoof.status}`);

  /* And the proxy's own view of the caller is what counts: a different source
     behind the same forged headers gets its own bucket. */
  const otherSource = await fetch(`${proxyBase}/api/auth/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1', 'X-Test-Source': '203.0.113.9' },
    body: JSON.stringify({ token: 'r_zzzzzz.deadbeef', password: 'nevermind1' }),
  });
  check('A genuinely different source still gets its own bucket', otherSource.status === 400, `got ${otherSource.status}`);

  /* ---- ten wrong passwords close the account, wherever they came from ----
     A per-address limit cannot see a guess spread over many addresses: each
     one arrives with a fresh bucket. So the account keeps its own count. Each
     attempt below comes from a different source as far as the proxy is
     concerned, which is exactly the case the address limit misses. */
  console.log('\nTen wrong passwords close the account');
  const LOCK_OWNER = 'locked@example.com';
  const LOCK_PW = 'lockedpass1';
  const fromSource = (path, body, srcN) => fetch(proxyBase + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Source': `203.0.113.${srcN}` },
    body: JSON.stringify(body),
  });

  const claimed = await fromSource('/api/auth/setup', { email: LOCK_OWNER, password: LOCK_PW }, 1);
  check('An account exists to lock', claimed.status === 200, `got ${claimed.status}`);

  const wrong = [];
  for (let i = 0; i < 10; i++) {
    const r = await fromSource('/api/auth/login', { email: LOCK_OWNER, password: 'wrongpass9' }, 20 + i);
    wrong.push(r.status);
  }
  check('Ten wrong passwords, each from a different address, are each refused on their merits',
    wrong.every(s => s === 401), wrong.join(','));

  const onDiskLock = JSON.parse(fs.readFileSync(path.join(SPOOF_DATA, 'account.json'), 'utf8'));
  check('The count is written to disk, so a restart cannot wipe it',
    onDiskLock.login && onDiskLock.login.failures === 10 && onDiskLock.login.until > Date.now(),
    JSON.stringify(onDiskLock.login));

  /* Restart it. The eleventh attempt still has to be refused, which is the
     whole point of persisting the counter. */
  spoofServer.kill();
  await new Promise(r => setTimeout(r, 400));
  spoofServer = startMapper(SPOOF_PORT, SPOOF_DATA, { LOGIN_LOCK_MINUTES: '0.2' }, true);
  check('The Mapper came back up', await waitFor(proxyBase));

  const eleventh = await fromSource('/api/auth/login', { email: LOCK_OWNER, password: 'wrongpass9' }, 90);
  const eleventhBody = await eleventh.json().catch(() => ({}));
  check('The eleventh is refused even from an address that has never been seen',
    eleventh.status === 429, `got ${eleventh.status}`);
  check('And it says so in plain English',
    /Too many wrong passwords\. Try again in \d+ minutes?\./.test(eleventhBody.error || ''), eleventhBody.error);

  const rightButLocked = await fromSource('/api/auth/login', { email: LOCK_OWNER, password: LOCK_PW }, 91);
  check('Even the right password is refused while the account is closed',
    rightButLocked.status === 429, `got ${rightButLocked.status}`);

  /* Wait the window out. 0.2 minutes is 12 seconds; the failures above took
     some of it already, so this waits from when the lock was set. */
  const waitMs = Math.max(0, onDiskLock.login.until - Date.now()) + 500;
  await new Promise(r => setTimeout(r, waitMs));
  const afterWindow = await fromSource('/api/auth/login', { email: LOCK_OWNER, password: LOCK_PW }, 92);
  check('The right password works once the window has passed', afterWindow.status === 200, `got ${afterWindow.status}`);

  const clearedLock = JSON.parse(fs.readFileSync(path.join(SPOOF_DATA, 'account.json'), 'utf8'));
  check('And signing in resets the count to nothing',
    clearedLock.login.failures === 0 && clearedLock.login.until === 0, JSON.stringify(clearedLock.login));

  /* ---- is this what's live? ----
     The headless run can only reach the "can't tell" state, because it has no
     HaTi to ask. The other two need both hashes, so they are asserted here
     against the verdict itself. */
  console.log('\nIs this what\'s live?');
  const scanned = { commit: 'a1b2c3d', changes: [
    { sha: 'a1b2c3d4e5f6' }, { sha: 'b2c3d4e5f607' }, { sha: 'c3d4e5f60718' }, { sha: 'd4e5f6071829' },
  ] };
  const same = driftVerdict(scanned, { available: true, version: 'a1b2c3d4e5f60718293a' });
  check('Matching versions read as good news', same.state === 'match', JSON.stringify(same));
  check('And say so in plain English', /You’re looking at the code that’s live\./.test(same.message), same.message);

  const behind = driftVerdict(scanned, { available: true, version: 'c3d4e5f60718293a4b5c' });
  check('A live version further down the list is counted', behind.state === 'different' && behind.behind === 2, JSON.stringify(behind));
  check('And the count is put into the sentence', /2 commits behind/.test(behind.message), behind.message);

  const unknownCommit = driftVerdict(scanned, { available: true, version: '9999999999999999' });
  check('A live version nobody recognises is still reported as different',
    unknownCommit.state === 'different' && unknownCommit.behind === null, JSON.stringify(unknownCommit));
  check('Without inventing a number', !/\d+ commits?/.test(unknownCommit.message), unknownCommit.message);

  const cannotTell = driftVerdict(scanned, { available: false, reason: 'nope' });
  check('An unreachable HaTi is "can\'t tell", never "probably fine"',
    cannotTell.state === 'unknown' && cannotTell.liveCommit === null, JSON.stringify(cannotTell));

  /* ---- history older than 72 hours survives ----
     The working set is still 72 hours and the default view is unchanged. What
     changed is that nothing is thrown away: every round is archived when it
     happens, so a question about last month has something to answer from. */
  console.log('\nHistory older than 72 hours');
  const HDATA = path.join(ROOT, '.tmp-history-data');
  fs.rmSync(HDATA, { recursive: true, force: true });

  /* Four scans, spread over three weeks, each one moving something. The dates
     are made up; everything else goes through the real recorder. */
  const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const fakeScan = (at, tables, files) => ({
    scannedAt: at, commit: 'c' + tables,
    screens: [], ai: { features: [] },
    storage: { tables: tables.map(n => ({ name: n, columns: ['id'] })) },
    public: { routes: [], hashes: [] }, gaps: { gaps: [], markerCount: 0 },
    weight: { files, orphans: [] }, streams: [], dependencies: { warnings: [] },
  });

  let h = new History(HDATA);
  h.record(fakeScan(daysAgo(21), ['contracts'], [{ path: 'a.js', bytes: 1000 }]));
  h.record(fakeScan(daysAgo(14), ['contracts', 'versions'], [{ path: 'a.js', bytes: 1000 }]));
  h.record(fakeScan(daysAgo(7), ['contracts', 'versions', 'shares'], [{ path: 'a.js', bytes: 40000 }]));
  h.record(fakeScan(new Date().toISOString(), ['contracts', 'versions', 'shares', 'audit'], [{ path: 'a.js', bytes: 40000 }]));

  check('Only today\'s change is inside the 72-hour window', h.changes(72).length === 1, `${h.changes(72).length} rounds`);
  /* The first scan is the baseline — there is nothing to compare it against —
     so four scans produce three rounds of changes. */
  check('Asking for 30 days finds the older ones too', h.changes(720).length === 3, `${h.changes(720).length} rounds`);
  check('Newest first, whichever range is asked for',
    new Date(h.changes(720)[0].at).getTime() > new Date(h.changes(720)[2].at).getTime());
  check('A three-week-old event is still readable in full',
    /A new place to store things was added: the “versions” table/.test(JSON.stringify(h.changes(720))),
    JSON.stringify(h.changes(720)[2] || {}).slice(0, 120));

  check('The archive was written to disk', fs.existsSync(path.join(HDATA, 'history-archive.json')));
  const archived = JSON.parse(fs.readFileSync(path.join(HDATA, 'history-archive.json'), 'utf8'));
  check('It holds one round per change', archived.rounds.length === 3, `${archived.rounds.length}`);
  check('And a measurement per scan for drawing trends', archived.points.length === 4, `${archived.points.length}`);
  check('Measurements are numbers only — no names, no paths',
    !/"path"|"name"|\.js/.test(JSON.stringify(archived.points)), JSON.stringify(archived.points[0]));

  /* Reopened from disk, with nothing in memory, the long view still answers. */
  h = new History(HDATA);
  check('Reopening from disk gives the same long view', h.changes(720).length === 3, `${h.changes(720).length} rounds`);
  check('And the default view is still just the working set', h.changes().length === 1, `${h.changes().length} rounds`);
  check('The measurement series survives too', h.points().length === 4, `${h.points().length} points`);
  check('The status says how far back the log goes',
    !!h.status().keptSince && h.status().archivedEvents >= 3, JSON.stringify(h.status()));
  fs.rmSync(HDATA, { recursive: true, force: true });

  /* ---- how much of HaTi the scanner could read ----
     The number that turns silent decay into something visible: when HaTi
     changes shape, panels do not break, they just fill with "not detected".
     Proved by taking a whole repository away from the scanner and watching the
     score fall. */
  console.log('\nHow much the scanner could read');
  const whole = readFixture(FIXTURE_DIR);
  const full = buildScan({ files: whole.files, commits: whole.commits, repo: 'fixture', ref: 'main', requestCount: 0 });
  check('The score is a percentage', typeof full.health.percent === 'number' && full.health.percent >= 0 && full.health.percent <= 100,
    JSON.stringify(full.health));
  check('It counts a real number of facts, not a handful', full.health.attempts >= 40, `${full.health.attempts} attempts`);
  check('A clean read scores highly', full.health.percent >= 95, `${full.health.percent}%`);

  const damaged = readFixture(FIXTURE_DIR);
  damaged.files.delete('SECURITY.md');
  damaged.files.delete('js/views/portal.js');
  const hurt = buildScan({ files: damaged.files, commits: damaged.commits, repo: 'fixture', ref: 'main', requestCount: 0 });
  check('Taking two files away lowers it', hurt.health.percent < full.health.percent,
    `${full.health.percent}% → ${hurt.health.percent}%`);
  check('And the reason is visible as warnings, not just a smaller number',
    hurt.warnings.length > full.warnings.length, `${full.warnings.length} → ${hurt.warnings.length} warnings`);

  check('The score goes into the snapshot, so it can be watched over time',
    snapshot(full).health === full.health.percent, `${snapshot(full).health}`);

  /* ---- what did last night's session do? ----
     The same events the log holds, grouped into one report. Seeded here with a
     known set of rounds so the grouping can be asserted exactly. */
  console.log('\nWhat did last night\'s session do?');
  const hoursAgo = n => new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
  const seeded = [
    { at: hoursAgo(2), commit: 'aaa1111', events: [
      { weight: 3, kind: 'public', text: 'A new address works without logging in: GET /api/notes.' },
      { weight: 2, kind: 'data', text: 'A new place to store things was added: the “notes” table, with 4 columns.' },
    ] },
    { at: hoursAgo(4), commit: 'bbb2222', events: [
      { weight: 1, kind: 'weight', text: 'js/views/notes.js grew from 12 KB to 31 KB.' },
    ] },
    { at: hoursAgo(80), commit: 'ccc3333', events: [
      { weight: 3, kind: 'ai', text: 'A new AI feature was added: Note summariser.' },
    ] },
  ];
  const seededPoints = [
    { at: hoursAgo(6), health: 98, bytes: 400000 },
    { at: hoursAgo(1), health: 91, bytes: 460000 },
  ];
  const seededScan = { changes: [
    { sha: 'aaa1111', subject: 'Add the notes table and its endpoint', date: hoursAgo(3), areas: ['server'] },
    { sha: 'zzz9999', subject: 'Something from last week', date: hoursAgo(200), areas: ['server'] },
  ] };

  const dg = buildDigest({ rounds: seeded, points: seededPoints, scan: seededScan, period: '24h' });
  check('Only what happened in the window is counted', dg.eventCount === 3, `${dg.eventCount} events`);
  check('The open door is the first area listed', dg.sections[0].kind === 'public', dg.sections.map(s => s.kind).join(','));
  check('Each area is grouped once, not repeated per scan',
    new Set(dg.sections.map(s => s.kind)).size === dg.sections.length, dg.sections.map(s => s.kind).join(','));
  check('The headline says how much moved, in words',
    /3 changes across 3 areas and 1 commit in the last 24 hours\./.test(dg.headline), dg.headline);
  check('And flags the ones worth looking at first',
    dg.seriousCount === 1 && /One of them is worth looking at first\./.test(dg.headline), dg.headline);
  check('The scanner\'s slip over the window is carried',
    dg.health && dg.health.from === 98 && dg.health.to === 91 && dg.health.delta === -7, JSON.stringify(dg.health));
  check('So is the growth in bytes', dg.bytesGrown === 60000, `${dg.bytesGrown}`);
  check('Only commits from the window come with it',
    dg.commits.length === 1 && dg.commits[0].sha === 'aaa1111', JSON.stringify(dg.commits));

  const quiet = buildDigest({ rounds: [], points: [], scan: { changes: [] }, period: 'midnight' });
  check('A quiet night says so rather than showing an empty page',
    quiet.quiet === true && /Nothing has moved in HaTi since midnight\./.test(quiet.headline), quiet.headline);

  const asText = digestText(dg, { link: 'https://example.invalid/' });
  check('The email version is plain text with no markup', !/[<>]/.test(asText), asText.slice(0, 80));
  check('It carries the events themselves', /A new address works without logging in/.test(asText));
  check('And says how to stop receiving it', /Turn them off there\./.test(asText));

  /* The route itself, on a real server with a real (empty) log. */
  const digestRes = await get('/api/digest');
  check('/api/digest answers with a session', digestRes.status === 200, `got ${digestRes.status}`);
  check('It defaults to since-midnight', digestRes.body.period === 'midnight', digestRes.body.period);
  check('And a fresh Mapper reports a quiet night rather than failing', digestRes.body.quiet === true, JSON.stringify(digestRes.body).slice(0, 120));

  /* The preference, and the fact that it degrades without a provider. */
  const prefs0 = await get('/api/preferences');
  check('Morning summaries are off until asked for', prefs0.body.digestEmail === false, JSON.stringify(prefs0.body));
  check('And the page is told no email provider is configured', prefs0.body.canEmail === false);
  const prefsOn = await call('PUT', '/api/preferences', { digestEmail: true });
  check('The preference can be switched on', prefsOn.status === 200 && prefsOn.body.digestEmail === true, JSON.stringify(prefsOn.body));
  check('It is written to disk', JSON.parse(fs.readFileSync(path.join(DATA, 'prefs.json'), 'utf8')).digestEmail === true);
  const digestAnon = await fetch(BASE + '/api/digest');
  check('Nobody without a session can read the summary', digestAnon.status === 401, `got ${digestAnon.status}`);

  /* ---- the documents describe the code as it is ----
     Documentation drift is the disease this whole tool exists to cure, so the
     statements that were once true and are now false are asserted gone. Each
     pattern below is a sentence that used to be in these files and that the
     code has since contradicted. */
  console.log('\nThe documents describe the code as it is');
  const DOCS = ['README.md', 'SUMMARY.md', 'server.mjs', 'app.js', 'lib/chat.mjs', 'lib/accounts.mjs', 'lib/history.mjs'];
  const CONTRADICTIONS = [
    [/this service has no login/i, 'claims this service has no login'],
    [/Mapper has no login/i, 'claims the Mapper has no login'],
    [/there is no access prompt|loads straight into the data/i, 'claims the page loads without a sign-in'],
    [/both routes answer any caller/i, 'claims the data routes answer any caller'],
    [/MAPPER_ACCESS_TOKEN/, 'still mentions MAPPER_ACCESS_TOKEN as if it existed'],
    [/the environment wins/i, 'claims the environment AI key beats the pasted one'],
    [/exposes two routes/i, 'claims the server exposes only two routes'],
  ];
  for (const [re, what] of CONTRADICTIONS) {
    const guilty = DOCS.filter(f => re.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    check(`Nothing ${what}`, guilty.length === 0, guilty.join(', '));
  }
} catch (e) {
  check('The login test itself completed', false, e.stack || String(e));
  console.error(log.slice(-2000));
} finally {
  server.kill();
  if (spoofServer) spoofServer.kill();
  if (spoofProxy) spoofProxy.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SPOOF_DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
