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
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';
import { driftVerdict } from '../lib/drift.mjs';
import { History, snapshot } from '../lib/history.mjs';
import { buildScan } from '../lib/scan.mjs';
import { stripRoot } from '../lib/tar.mjs';
import { readFixture } from '../lib/fixture.mjs';
import { buildDigest, digestText } from '../lib/digest.mjs';
import { evaluateWatch } from '../lib/watch.mjs';
import { WATCH_DEFAULTS } from '../lib/prefs.mjs';
import { planCheck, CHECK_CAP, THROTTLE_MS } from '../lib/doors.mjs';
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

/* A third Mapper, pointed at a source directory that does not exist yet, so
   its scans fail until the directory is created under it. */
const TROUBLE_PORT = PORT + 3;
const TROUBLE_DATA = path.join(ROOT, '.tmp-trouble-data');
const TROUBLE_SOURCE = path.join(ROOT, '.tmp-trouble-source');
let troubleServer = null;

/* A fourth Mapper, pointed at a stand-in HaTi that answers each of the
   fixture's open doors differently, so every verdict can be seen. */
const DOORS_PORT = PORT + 4;
const STUB_PORT = PORT + 5;
const DOORS_DATA = path.join(ROOT, '.tmp-doors-data');
let doorsServer = null, stubHati = null;

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

  /* ---- does the state survive a deploy, and does the page know? ----
     This was reported from whether a write succeeded, which on a host that
     replaces the service's directory every deploy is a different question with
     the same answer — right up until the deploy. So the page told the owner
     the account, the key and the change log were safe while every one of them
     was being wiped on each ship.

     The three states are now distinct. This run writes to a directory inside
     the repository, which is exactly the case that used to report as safe, so
     it is the one worth pinning: writable, and known not to be permanent. */
  /* Looks that found nothing leave no snapshot — that is the point of the log
     — so the service could not say how often it had looked, and the page said
     it anyway out of the snapshot count. The number now exists for real,
     because "looked twice, found nothing" and "looked two hundred times, found
     nothing" are opposite facts and the page draws a conclusion from it. */
  const beforeLooks = (await get('/api/changes')).body.looks;
  await get('/api/scan?refresh=1');
  const afterLooks = (await get('/api/changes')).body.looks;
  check('Every look is counted, including the ones that find nothing',
    typeof beforeLooks === 'number' && afterLooks === beforeLooks + 1,
    `${beforeLooks} → ${afterLooks}`);
  check('And the count survives being written down',
    JSON.parse(fs.readFileSync(path.join(DATA, 'history.json'), 'utf8')).looks === afterLooks,
    `on disk ${JSON.parse(fs.readFileSync(path.join(DATA, 'history.json'), 'utf8')).looks}, in memory ${afterLooks}`);

  check('The page is told whether the state directory can be written to',
    cfg2.body.storageIsWritable === true, JSON.stringify(cfg2.body.storageIsWritable));
  check('And separately, whether it survives a deploy',
    cfg2.body.storageIsMounted === false,
    `storageIsMounted=${cfg2.body.storageIsMounted} for ${cfg2.body.storagePath}`);
  check('Writable is no longer reported as permanent',
    !('storageIsDurable' in cfg2.body), Object.keys(cfg2.body).join(','));
  check('And it says which directory it means, so the claim can be checked',
    typeof cfg2.body.storagePath === 'string' && cfg2.body.storagePath.length > 0,
    cfg2.body.storagePath);

  /* A directory outside the service's own is what a mounted volume looks like
     from inside the container, and it has to report as one. Asserted against a
     second server rather than by trusting the first — the whole point is that
     the two cases are told apart. */
  const MOUNTED = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-mounted-'));
  const mountedPort = PORT + 7;
  const mBase = `http://127.0.0.1:${mountedPort}`;
  const mounted = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(mountedPort), MAPPER_DATA: MOUNTED, MAPPER_OWNER_EMAIL: OWNER,
      HATI_URL: '', MAPPER_TOKEN: '', RESEND_API_KEY: '', ...source.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${mBase}/api/health`)).ok) { up = true; break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    check('A second Mapper started on a directory outside its own', up);
    const mSetup = await fetch(`${mBase}/api/auth/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OWNER, password: 'mountedpass1' }),
    });
    const mCookie = (mSetup.headers.get('set-cookie') || '').split(';')[0];
    const mCfg = await (await fetch(`${mBase}/api/ai/config`, { headers: { Cookie: mCookie } })).json();
    check('State outside the service directory reports as surviving a deploy',
      mCfg.storageIsMounted === true && mCfg.storageIsWritable === true,
      `mounted=${mCfg.storageIsMounted} writable=${mCfg.storageIsWritable} at ${mCfg.storagePath}`);
  } finally {
    mounted.kill();
    fs.rmSync(MOUNTED, { recursive: true, force: true });
  }

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

  /* ---- the version comes from the tarball, not the history fetch ----
     The scan's version used to be the newest sha in the commit history, which
     is a separate, best-effort, twenty-request fetch — and the first thing a
     rate limit lands on. Whenever it failed, the badge went grey saying "could
     not read which version", though the tarball's own root directory had named
     the exact commit on the very first request. */
  const shaTar = new Map([
    ['youngmbg21-cmyk-mkataba-clm-9f8e7d6c5b4a/index.html', Buffer.from('x')],
    ['youngmbg21-cmyk-mkataba-clm-9f8e7d6c5b4a/js/app.js', Buffer.from('y')],
  ]);
  const stripped = stripRoot(shaTar);
  check('The tarball root names the commit and stripRoot hands it back',
    stripped.root === 'youngmbg21-cmyk-mkataba-clm-9f8e7d6c5b4a' && stripped.files.has('index.html'),
    JSON.stringify({ root: stripped.root, keys: [...stripped.files.keys()] }));
  const strippedFlat = stripRoot(new Map([['index.html', Buffer.from('x')]]));
  check('A tarball with no single root still unpacks, with no commit claimed',
    strippedFlat.root === null && strippedFlat.files.has('index.html'),
    JSON.stringify({ root: strippedFlat.root }));

  const fromTarball = buildScan({
    files: readFixture(FIXTURE_DIR).files, commits: null,
    repo: 'f', ref: 'main', requestCount: 1, tarballCommit: '9f8e7d6',
  });
  check('A scan whose history fetch failed still knows its version',
    fromTarball.commit === '9f8e7d6', String(fromTarball.commit));
  check('So the badge can compare it with the live site as usual',
    driftVerdict(fromTarball, { available: true, version: '9f8e7d6c5b4a' }).state === 'match');

  /* And when even the tarball cannot say, the badge explains why instead of
     shrugging: the commit error travels as its own field. */
  const noVersion = driftVerdict({ commit: null, commitError: 'GitHub 403: rate limit' }, { available: true, version: '9f8e7d6c5b4a' });
  check('A version the scan could not read is explained, not left a mystery',
    noVersion.state === 'unknown' && noVersion.reason === 'GitHub 403: rate limit' &&
    /could not read HaTi’s commit history/.test(noVersion.message),
    JSON.stringify(noVersion));

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

  /* ---- tripwires ----
     Each rule is tripped by a seeded pair of snapshots, so what is asserted is
     the rule firing on the right change and staying quiet on the others. */
  console.log('\nTripwires');
  const snapOf = (over) => ({
    at: new Date().toISOString(), openRoutes: [], hashRoutes: [], files: [], health: 100, ...over,
  });
  const armed = (name, threshold) => ({
    ...Object.fromEntries(Object.keys(WATCH_DEFAULTS).map(k => [k, { on: false, threshold: null }])),
    [name]: { on: true, threshold: threshold ?? null },
  });

  const doorOpened = evaluateWatch({
    prev: snapOf({ openRoutes: ['GET /api/contracts'] }),
    next: snapOf({ openRoutes: ['GET /api/contracts', 'GET /api/notes'] }),
    rules: armed('openRoute'),
  });
  check('A door that opens with no login trips its rule', doorOpened.length === 1, JSON.stringify(doorOpened));
  check('It names the address and says why it matters',
    /GET \/api\/notes now answers without anyone logging in/.test(doorOpened[0].text), doorOpened[0].text);
  check('And it is the one that does not wait until morning', doorOpened[0].immediate === true);

  const newLink = evaluateWatch({
    prev: snapOf({ hashRoutes: ['share'] }),
    next: snapOf({ hashRoutes: ['share', 'invoice'] }),
    rules: armed('publicLink'),
  });
  check('A new kind of public link trips its rule',
    newLink.length === 1 && /#invoice/.test(newLink[0].text), JSON.stringify(newLink));

  const grew = evaluateWatch({
    prev: snapOf({ files: [{ path: 'js/big.js', bytes: 90 * 1024 }] }),
    next: snapOf({ files: [{ path: 'js/big.js', bytes: 130 * 1024 }] }),
    rules: armed('fileSize', 100),
  });
  check('A file crossing the size you set trips its rule',
    grew.length === 1 && /js\/big\.js is now 130 KB, past the 100 KB/.test(grew[0].text), JSON.stringify(grew));
  const stillBig = evaluateWatch({
    prev: snapOf({ files: [{ path: 'js/big.js', bytes: 130 * 1024 }] }),
    next: snapOf({ files: [{ path: 'js/big.js', bytes: 140 * 1024 }] }),
    rules: armed('fileSize', 100),
  });
  check('But a file that was already over it does not trip every scan', stillBig.length === 0, JSON.stringify(stillBig));

  const spending = evaluateWatch({
    prev: snapOf({}), next: snapOf({}),
    pulse: { available: true, usage: { count: 240, date: '2026-07-26' } },
    rules: armed('aiRequests', 150),
  });
  check('Too many AI requests on the live site trips its rule',
    spending.length === 1 && /240 AI requests today, past the 150/.test(spending[0].text), JSON.stringify(spending));
  const noPulse = evaluateWatch({
    prev: snapOf({}), next: snapOf({}), pulse: { available: false }, rules: armed('aiRequests', 150),
  });
  check('With no live HaTi it stays quiet rather than assuming the best', noPulse.length === 0);

  const slipped = evaluateWatch({
    prev: snapOf({ health: 97 }), next: snapOf({ health: 71 }), rules: armed('scanHealth', 90),
  });
  check('The scanner losing its grip trips its rule',
    slipped.length === 1 && /read only 71% .* below the 90%/.test(slipped[0].text), JSON.stringify(slipped));

  const allOff = evaluateWatch({
    prev: snapOf({ openRoutes: [] }),
    next: snapOf({ openRoutes: ['GET /api/notes'], health: 10, files: [{ path: 'a.js', bytes: 999999 }] }),
    rules: Object.fromEntries(Object.keys(WATCH_DEFAULTS).map(k => [k, { on: false, threshold: 1 }])),
  });
  check('A rule that is switched off never fires', allOff.length === 0, JSON.stringify(allOff));

  /* The route, and that the two dangerous ones are armed out of the box. */
  const watch0 = await get('/api/watch');
  check('/api/watch lists every rule in plain words', watch0.status === 200 && watch0.body.rules.length === 5,
    JSON.stringify(watch0.body.rules?.map(r => r.name)));
  check('The two about someone reaching HaTi are on by default',
    watch0.body.rules.filter(r => r.on).map(r => r.name).sort().join(',') === 'openRoute,publicLink',
    watch0.body.rules.filter(r => r.on).map(r => r.name).join(','));
  check('Each rule is phrased as an instruction, not a setting name',
    watch0.body.rules.every(r => /^Tell me/.test(r.plain)), watch0.body.rules[0].plain);

  const armRule = await call('PUT', '/api/watch', { name: 'fileSize', on: true, threshold: 60 });
  check('A rule can be armed and given a number', armRule.status === 200 &&
    armRule.body.rules.find(r => r.name === 'fileSize').threshold === 60,
    JSON.stringify(armRule.body.rules.find(r => r.name === 'fileSize')));
  check('And it is written to disk, so it survives a restart',
    JSON.parse(fs.readFileSync(path.join(DATA, 'prefs.json'), 'utf8')).watch.fileSize.threshold === 60);
  const junkRule = await call('PUT', '/api/watch', { name: 'nonsense', on: true });
  check('A rule nobody has heard of is refused', junkRule.status === 400, `got ${junkRule.status}`);

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
  /* The two halves are named differently on purpose. "Changes" is what the
     Mapper observed by comparing its own scans; a save is a code update. They
     were both called changes, which put this headline at odds with the tower's
     calendar — the calendar counting only the first while the sentence added
     the second in. Both numbers were right; only the word was wrong. */
  check('The headline says how much moved, in words',
    /3 changes across 3 areas and 1 code update in the last 24 hours\./.test(dg.headline), dg.headline);
  check('And does not call a save a change',
    !/\d+ commits?\b/.test(dg.headline) && /1 code update/.test(dg.headline), dg.headline);
  check('And flags the ones worth looking at first',
    dg.seriousCount === 1 && /One of them is worth looking at first\./.test(dg.headline), dg.headline);
  check('The scanner\'s slip over the window is carried',
    dg.health && dg.health.from === 98 && dg.health.to === 91 && dg.health.delta === -7, JSON.stringify(dg.health));
  check('So is the growth in bytes', dg.bytesGrown === 60000, `${dg.bytesGrown}`);
  check('Only commits from the window come with it',
    dg.commits.length === 1 && dg.commits[0].sha === 'aaa1111', JSON.stringify(dg.commits));

  /* Numbering, in the order the work happened. GitHub hands them over newest
     first, which is the wrong way round for a report about a night's work. */
  const ordered = buildDigest({
    rounds: [], points: [], period: '24h',
    scan: { changes: [
      { sha: 'ccc3333', subject: 'The last thing the session did', date: hoursAgo(1) },
      { sha: 'aaa1111', subject: 'The first thing the session did', date: hoursAgo(9) },
      { sha: 'bbb2222', subject: 'The middle thing', date: hoursAgo(5) },
    ] },
  });
  check('The night\'s changes are numbered from one',
    ordered.commits.map(c => c.n).join(',') === '1,2,3', ordered.commits.map(c => c.n).join(','));
  check('And numbered in the order they happened, not the order GitHub lists them',
    ordered.commits[0].sha === 'aaa1111' && ordered.commits[2].sha === 'ccc3333',
    ordered.commits.map(c => `${c.n}:${c.sha}`).join(' '));
  const orderedText = digestText(ordered);
  check('The email numbers them the same way, so both tell one story',
    /1\. The first thing the session did \(aaa1111\)/.test(orderedText) &&
    /3\. The last thing the session did \(ccc3333\)/.test(orderedText),
    orderedText.split('\n').slice(4, 9).join(' | '));

  /* A count of zero looks like a fault when it sits under a list of changes.
     Both halves are true — the commits are GitHub's record, the scans are the
     Mapper's own — and the wording has to carry that difference itself. */
  check('A report built before the first scan does not claim "0 scans"',
    ordered.scanCount === 0 && !/\b0 scans?\b/.test(orderedText), orderedText);
  check('It says the changes came from GitHub and the Mapper has not looked yet',
    /straight from GitHub's record/.test(orderedText) && /not taken a look yet/.test(orderedText),
    orderedText.split('\n').filter(l => /GitHub/.test(l)).join(' '));

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
  /* A Mapper that has only just started has nothing of its own to report, but
     GitHub's commits are there from the first scan. That combination used to
     print "0 scans" under a list of changes, which reads as a fault. */
  check('A fresh Mapper answers rather than failing', digestRes.body.eventCount === 0,
    JSON.stringify(digestRes.body).slice(0, 140));
  check('It has commits to show before it has watched anything itself',
    digestRes.body.commits.length > 0 && digestRes.body.scanCount === 0,
    `${digestRes.body.commits.length} commits, ${digestRes.body.scanCount} scans`);
  check('So it is not called a quiet night', digestRes.body.quiet === false, `quiet=${digestRes.body.quiet}`);

  /* The preference, and the fact that it degrades without a provider. */
  const prefs0 = await get('/api/preferences');
  check('Morning summaries are off until asked for', prefs0.body.digestEmail === false, JSON.stringify(prefs0.body));
  check('And the page is told no email provider is configured', prefs0.body.canEmail === false);
  const prefsOn = await call('PUT', '/api/preferences', { digestEmail: true });
  check('The preference can be switched on', prefsOn.status === 200 && prefsOn.body.digestEmail === true, JSON.stringify(prefsOn.body));
  check('It is written to disk', JSON.parse(fs.readFileSync(path.join(DATA, 'prefs.json'), 'utf8')).digestEmail === true);
  const digestAnon = await fetch(BASE + '/api/digest');
  check('Nobody without a session can read the summary', digestAnon.status === 401, `got ${digestAnon.status}`);

  /* ---- a monitoring tool that stops monitoring ----
     The dangerous failure: the scan stops working, the page keeps showing the
     last good one, and everything looks fine. This Mapper is pointed at a
     source directory that does not exist, so its scans fail — and the
     directory is created under it afterwards to prove recovery. */
  console.log('\nWhen the Mapper cannot read HaTi');
  fs.rmSync(TROUBLE_SOURCE, { recursive: true, force: true });
  troubleServer = startMapper(TROUBLE_PORT, TROUBLE_DATA, {
    HATI_FIXTURE: TROUBLE_SOURCE,
    // A key that will never work, so the send is attempted and fails. What is
    // being asserted is that it is attempted once, not that it arrives.
    RESEND_API_KEY: 'not-a-real-key-for-tests',
  });
  const troubleBase = `http://127.0.0.1:${TROUBLE_PORT}`;
  check('A Mapper with nothing to read started', await waitFor(troubleBase));

  let troubleCookie = '';
  const troubleCall = async (method, p, body) => {
    const r = await fetch(troubleBase + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(troubleCookie ? { Cookie: troubleCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const c = r.headers.get('set-cookie');
    if (c) troubleCookie = c.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await troubleCall('POST', '/api/auth/setup', { email: 'trouble@example.com', password: 'troubled1' });

  const readPrefs = () => JSON.parse(fs.readFileSync(path.join(TROUBLE_DATA, 'prefs.json'), 'utf8'));
  const failures = [];
  for (let i = 0; i < 2; i++) failures.push((await troubleCall('GET', '/api/scan?refresh=1')).status);
  check('A failing scan says so rather than pretending', failures.every(s => s === 502), failures.join(','));
  check('Two failures are counted but nothing is raised yet',
    readPrefs().failedScans === 2 && readPrefs().scanAlertSent === false, JSON.stringify(readPrefs().failedScans));
  const watchQuiet = await troubleCall('GET', '/api/watch');
  check('And no banner is shown for two', watchQuiet.body.scanTrouble === null, JSON.stringify(watchQuiet.body.scanTrouble));

  const third = await troubleCall('GET', '/api/scan?refresh=1');
  check('The third failure is the one that matters', third.status === 502);
  check('Exactly one alert is raised at the third', readPrefs().scanAlertSent === true, JSON.stringify(readPrefs()));
  const watchLoud = await troubleCall('GET', '/api/watch');
  check('And the page is given something to show',
    watchLoud.body.scanTrouble && watchLoud.body.scanTrouble.failedScans === 3, JSON.stringify(watchLoud.body.scanTrouble));
  check('With the plain reason it failed',
    /does not exist/.test(watchLoud.body.scanTrouble.reason || ''), watchLoud.body.scanTrouble.reason);

  for (let i = 0; i < 2; i++) await troubleCall('GET', '/api/scan?refresh=1');
  check('More failures do not raise more alerts',
    readPrefs().failedScans === 5 && readPrefs().scanAlertSent === true, JSON.stringify(readPrefs()));

  /* Give it something to read, and it should recover on the next scan. */
  fs.cpSync(FIXTURE_DIR, TROUBLE_SOURCE, { recursive: true });
  const recovered = await troubleCall('GET', '/api/scan?refresh=1');
  check('It recovers as soon as there is something to read', recovered.status === 200, `got ${recovered.status}`);
  check('And the count is wiped, so the next outage alerts again',
    readPrefs().failedScans === 0 && readPrefs().scanAlertSent === false, JSON.stringify(readPrefs()));
  const watchClear = await troubleCall('GET', '/api/watch');
  check('The banner goes with it', watchClear.body.scanTrouble === null, JSON.stringify(watchClear.body.scanTrouble));

  /* ---- what it costs to run ----
     The panel showed models and request counts and never money. It now
     estimates, from the only ceiling the source states — each handler's
     max_tokens — and says out loud that it is a ceiling. */
  console.log('\nWhat it costs to run');
  const cost = full.cost;
  check('Every feature gets a per-use estimate', cost.features.length === full.ai.features.length,
    `${cost.features.length} of ${full.ai.features.length}`);
  check('The estimate is money, derived from the handler\'s own answer limit',
    cost.features.every(f => f.maxTokens > 0 && f.perRequestUsd > 0),
    JSON.stringify(cost.features[0]));
  check('An expensive model costs more per use than a cheap one',
    cost.features.find(f => f.pricedModel === 'claude-sonnet-5').perRequestUsd >
    cost.features.find(f => /haiku/.test(f.pricedModel)).perRequestUsd);
  check('A whole day has a ceiling', cost.dailyCeilingUsd > 0 && cost.dailyLimit > 0,
    `${cost.dailyLimit} requests → ${cost.dailyCeilingUsd}`);
  check('And it is labelled as a ceiling, not a bill',
    /rough ceiling, not a bill/.test(cost.assumption), cost.assumption);
  check('The price list says when it was last checked', !!cost.asOf && typeof cost.ageDays === 'number',
    `${cost.asOf}, ${cost.ageDays} days ago`);
  check('Fresh prices are not flagged as stale', cost.stale === false, `${cost.ageDays} days`);
  check('The daily estimate goes into the snapshot', snapshot(full).dailyCostUsd === cost.dailyMixedUsd,
    `${snapshot(full).dailyCostUsd}`);
  check('No money crosses the payload as a currency string',
    !/[£$€]/.test(JSON.stringify(cost)), (JSON.stringify(cost).match(/[£$€][^,}]*/) || [])[0] || '');

  /* A model nobody has priced must show as unknown, never be guessed at from
     a similar-looking name. */
  const oddModel = readFixture(FIXTURE_DIR);
  oddModel.files.set('server/server.js', Buffer.from(
    oddModel.files.get('server/server.js').toString('utf8')
      .replace("fast: 'claude-haiku-4-5-20251001'", "fast: 'claude-haiku-9-9-invented'")));
  const unpriced = buildScan({ files: oddModel.files, commits: oddModel.commits, repo: 'f', ref: 'main', requestCount: 0 });
  check('A model with no price is reported, not guessed at',
    unpriced.cost.modelsWithoutPrice.includes('claude-haiku-9-9-invented'),
    JSON.stringify(unpriced.cost.modelsWithoutPrice));
  check('Its features have no cost rather than an invented one',
    unpriced.cost.features.filter(f => f.pricedModel === null).length > 0);
  check('And the scan warns about it in plain English',
    unpriced.warnings.some(w => /has no price in data\/pricing\.js/.test(w)),
    unpriced.warnings.find(w => /price/.test(w)) || '(none)');
  check('Which also drags the health score down', unpriced.health.percent < full.health.percent,
    `${full.health.percent}% → ${unpriced.health.percent}%`);

  /* ---- severity on the "Not finished" list ----
     An optional convention: a bullet that starts [high] / [medium] / [low]
     states its own severity. Nothing is inferred — an untagged document must
     behave exactly as it did before. */
  console.log('\nSeverity on the "Not finished" list');
  check('Untagged documents state no severity at all',
    full.gaps.gaps.every(g => g.severity === null) && full.gaps.ranked === false,
    `${full.gaps.gaps.filter(g => g.severity).length} tagged`);
  const sourceOrder = full.gaps.gaps.map(g => g.title);

  const tagged = readFixture(FIXTURE_DIR);
  tagged.files.set('README.md', Buffer.from(
    tagged.files.get('README.md').toString('utf8')
      .replace('- **Rich text is stored as HTML.**', '- [low] **Rich text is stored as HTML.**')
      .replace('- **There is no audit export.**', '- [HIGH] **There is no audit export.**')
      .replace('- **Bulk import has no undo.**', '- [medium] **Bulk import has no undo.**')));
  const ranked = buildScan({ files: tagged.files, commits: tagged.commits, repo: 'f', ref: 'main', requestCount: 0 });

  check('A tagged bullet takes the severity the document states',
    ranked.gaps.gaps.filter(g => g.severity).length === 3,
    JSON.stringify(ranked.gaps.severityCounts));
  check('Case does not matter', ranked.gaps.gaps.some(g => g.severity === 'high'),
    JSON.stringify(ranked.gaps.gaps.filter(g => g.severity).map(g => g.severity)));
  check('High comes before medium comes before low',
    ranked.gaps.gaps.filter(g => g.severity).map(g => g.severity).join(',') === 'high,medium,low',
    ranked.gaps.gaps.filter(g => g.severity).map(g => g.severity).join(','));
  check('And the ranked ones come before everything untagged',
    ranked.gaps.gaps.slice(0, 3).every(g => g.severity) && !ranked.gaps.gaps[3].severity,
    ranked.gaps.gaps.slice(0, 4).map(g => g.severity).join(','));
  check('The tag itself never leaks into the title',
    !ranked.gaps.gaps.some(g => /\[(high|medium|low)\]/i.test(g.title + ' ' + (g.detail || ''))),
    ranked.gaps.gaps.map(g => g.title).find(t => /\[/.test(t)) || '');
  check('The panel is told it may rank them', ranked.gaps.ranked === true);
  check('Untagged bullets keep the order the source wrote them in',
    ranked.gaps.gaps.filter(g => !g.severity).map(g => g.title).join('|') ===
    sourceOrder.filter(t => ranked.gaps.gaps.find(g => g.title === t && !g.severity)).join('|'));

  /* Opened and closed over time, counted from tagged log events rather than
     by matching their wording. */
  const GDATA = path.join(ROOT, '.tmp-gapmove-data');
  fs.rmSync(GDATA, { recursive: true, force: true });
  const gh = new History(GDATA);
  const gapScan = (at, list) => ({
    scannedAt: at, commit: 'g', screens: [], ai: { features: [] },
    storage: { tables: [] }, public: { routes: [], hashes: [] },
    gaps: { gaps: list.map(t => ({ title: t })), markerCount: 0 },
    weight: { files: [], orphans: [] }, streams: [], dependencies: { warnings: [] },
  });
  gh.record(gapScan(daysAgo(20), ['one', 'two', 'three']));
  gh.record(gapScan(daysAgo(10), ['one', 'three', 'four']));            // two closed, four opened
  gh.record(gapScan(new Date().toISOString(), ['one', 'four', 'five'])); // three closed, five opened
  const movement = gh.gapMovement(30);
  check('Gaps opening and closing are counted over a window',
    movement.opened === 2 && movement.closed === 2, JSON.stringify(movement));
  check('Counted from a tag, not from the wording of the sentence',
    gh.changes(720).some(r => r.events.some(e => e.tag === 'gap-opened')),
    JSON.stringify(gh.changes(720)[0].events[0]));
  check('A shorter window sees only what happened inside it',
    gh.gapMovement(5).opened === 1 && gh.gapMovement(5).closed === 1, JSON.stringify(gh.gapMovement(5)));
  fs.rmSync(GDATA, { recursive: true, force: true });

  /* ---- a file is a thing, not an address ----
     The point of this panel is that the owner does not read code, so almost
     none of these sentences may be hand-written: a file that renders a screen
     borrows that screen's words, and a file the dependency map names borrows
     the subsystem titles it holds. Both of those are already validated on
     every scan, so they cannot quietly become wrong. */
  console.log('\nWhat each file is');
  const sizedFiles = full.weight.files;
  const byPath = Object.fromEntries(sizedFiles.map(f => [f.path, f]));

  check('Every file carries a plain-English name and a sentence',
    sizedFiles.every(f => f.name && f.does), sizedFiles.filter(f => !f.does).map(f => f.path).join(', ') || 'all described');
  check('Almost none of it is hand-written — it is borrowed from what is already derived',
    sizedFiles.filter(f => f.from === 'copy').length <= 2 && sizedFiles.filter(f => f.from !== 'copy').length >= 20,
    JSON.stringify(sizedFiles.reduce((n, f) => ({ ...n, [f.from]: (n[f.from] || 0) + 1 }), {})));
  check('The file every route is answered in counts its own routes',
    byPath['server/server.js'].from === 'routes' &&
    byPath['server/server.js'].does.includes(`all ${full.public.totalRoutes} of them`),
    byPath['server/server.js'].does);
  /* Any file the scan described from a screen, rather than one named here.
     Pinning a path asserted which file happened to render a screen when the
     test was written, and broke when the stand-in's menu was reshaped — while
     the property it exists to prove was still true of a different file. */
  const fromScreen = sizedFiles.find(f => f.from === 'screens');
  check('A screen’s own module is named after the screen',
    !!fromScreen && /screen$/.test(fromScreen.name),
    fromScreen ? `${fromScreen.path} — ${fromScreen.name}` : 'no file was described from a screen');
  check('And says what a person does there, in the screen’s own words',
    !!fromScreen && fromScreen.does === (full.screens.find(s => s.module === fromScreen.path) || {}).does,
    fromScreen ? fromScreen.does : 'n/a');
  check('A file the dependency map names is the parts it holds',
    byPath['js/core.js'].from === 'map' && /Signature seal/.test(byPath['js/core.js'].name),
    `${byPath['js/core.js'].name} — ${byPath['js/core.js'].does}`);
  check('A file holding several parts lists them all rather than picking one',
    byPath['js/versioning.js'].name.split(' · ').length === 2, byPath['js/versioning.js'].name);
  check('Nothing invents a sentence from a file name',
    sizedFiles.every(f => !f.does || !f.does.includes('.js')), (sizedFiles.find(f => (f.does || '').includes('.js')) || {}).path);

  /* Validated the same way every other hand-written file is: an entry for a
     file that has gone is stale and says so, rather than sitting there wrong. */
  const goneFiles = new Map(readFixture(FIXTURE_DIR).files);
  goneFiles.delete('js/templates.js');
  const missingFile = buildScan({ files: goneFiles, commits: null });
  check('An entry for a file that no longer exists is reported, not left to rot',
    missingFile.warnings.some(w => /describes a file "js\/templates\.js"/.test(w)),
    missingFile.warnings.filter(w => /file "/.test(w)).join(' | '));
  check('A file nothing can explain says so rather than being guessed at',
    (function () {
      const extra = new Map(readFixture(FIXTURE_DIR).files);
      extra.set('js/mystery.js', Buffer.from('/* nothing references this */\n'.repeat(40)));
      const s = buildScan({ files: extra, commits: null });
      const row = s.weight.files.find(f => f.path === 'js/mystery.js');
      return row && row.name === null && row.does === null;
    })(), 'an unexplained file must come back with no sentence at all');

  /* ---- knocking on the doors ----
     "Open to the public" is a claim about HaTi's source. This is the one place
     the Mapper checks that claim against a running site, so the stand-in HaTi
     below answers each open door differently and every verdict is asserted —
     including the two that matter most: a door the code says is open that the
     live site guards, and a door the code says is guarded that hands data to
     anyone. */
  console.log('\nKnocking on the doors');

  /* Nothing here is exercised without a plan, so the plan is checked first,
     with no network involved at all. */
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ method: 'GET', path: `/api/thing/${i}`, line: i });
  many.push({ method: 'POST', path: '/api/pay', line: 99 });
  many.push({ method: 'GET', path: '/api/share/:token', line: 100, tokenInPath: true });
  const planned = planCheck(many);
  check('The plan stops at the cap however many doors there are',
    planned.plan.length === CHECK_CAP, `${planned.plan.length} planned`);
  check('Everything past the cap is listed as skipped, not dropped',
    planned.plan.length + planned.skipped.length === many.length,
    `${planned.plan.length} + ${planned.skipped.length} of ${many.length}`);
  check('A door that would write data is never knocked on',
    planned.skipped.some(s => s.address === 'POST /api/pay' && s.reason === 'not checked: checking would write data'),
    JSON.stringify(planned.skipped.find(s => /pay/.test(s.address))));
  check('And a door needing a private code is left alone too',
    planned.skipped.some(s => /share/.test(s.address) && /unguessable code/.test(s.reason)),
    JSON.stringify(planned.skipped.find(s => /share/.test(s.address))));
  check('Each skipped door says why in plain English',
    planned.skipped.every(s => /^not checked: /.test(s.reason)));

  /* The stand-in HaTi. One answer per door, chosen to produce one of each
     verdict against the fixture's own list of open routes. */
  stubHati = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>HaTi</title>');
      if (url === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      // The code says no login is needed; something in front of it disagrees.
      if (url === '/api/status') return res.writeHead(401).end('{"error":"sign in"}');
      // The code says this one checks its own bearer token. It does not.
      if (url === '/api/pulse') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ secret: 'x'.repeat(200) }));
      // Nothing answers at all.
      if (url === '/api/advice/rates') return req.socket.destroy();
      res.writeHead(404).end('{}');
    });
    srv.listen(STUB_PORT, () => resolve(srv)).on('error', reject);
  });

  doorsServer = startMapper(DOORS_PORT, DOORS_DATA, { HATI_URL: `http://127.0.0.1:${STUB_PORT}` });
  const doorsBase = `http://127.0.0.1:${DOORS_PORT}`;
  check('A Mapper pointed at a running HaTi started', await waitFor(doorsBase));

  let doorsCookie = '';
  const doorsCall = async (method, p, body) => {
    const r = await fetch(doorsBase + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(doorsCookie ? { Cookie: doorsCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const c = r.headers.get('set-cookie');
    if (c) doorsCookie = c.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const doorsAnon = await fetch(doorsBase + '/api/public-check', { method: 'POST' });
  check('Nobody without a session can make the Mapper knock', doorsAnon.status === 401, `got ${doorsAnon.status}`);

  await doorsCall('POST', '/api/auth/setup', { email: 'doors@example.com', password: 'doorway12' });
  const before = await doorsCall('GET', '/api/public-check');
  check('Before the button is pressed, nothing has been knocked on',
    before.body.available === true && before.body.last === null, JSON.stringify(before.body));
  check('And the limits are stated up front, not after the fact',
    before.body.cap === CHECK_CAP && before.body.throttleMs === THROTTLE_MS, JSON.stringify(before.body));

  await doorsCall('GET', '/api/scan');           // there must be a list of doors first
  const knocked = await doorsCall('POST', '/api/public-check');
  check('The check runs when the owner asks for it', knocked.status === 200, JSON.stringify(knocked.body));

  const said = Object.fromEntries((knocked.body.results || []).map(r => [r.address, r]));
  check('A door the code says is open, and is: as written',
    said['GET /health'] && said['GET /health'].verdict === 'as-expected', JSON.stringify(said['GET /health']));
  check('A door the code says is open but the live site guards: flagged',
    said['GET /api/status'] && said['GET /api/status'].verdict === 'needs-login', JSON.stringify(said['GET /api/status']));
  check('A door the code says checks its own secret but hands over data: flagged',
    said['GET /api/pulse'] && said['GET /api/pulse'].verdict === 'unexpected-data', JSON.stringify(said['GET /api/pulse']));
  check('A door that does not answer at all: said so, not guessed at',
    said['GET /api/advice/rates'] && said['GET /api/advice/rates'].verdict === 'unreachable',
    JSON.stringify(said['GET /api/advice/rates']));
  check('Every result says in plain English what happened',
    knocked.body.results.every(r => typeof r.says === 'string' && r.says.length > 20));

  check('The routes that would write data were skipped with the reason given',
    knocked.body.skipped.filter(s => s.reason === 'not checked: checking would write data').length === 2,
    JSON.stringify(knocked.body.skipped));
  check('No POST was ever sent to the live site',
    knocked.body.results.every(r => r.address.startsWith('GET ')), JSON.stringify(knocked.body.results.map(r => r.address)));

  /* Five doors knocked on means four waits between them. The throttle is the
     difference between a person knocking and a scanner sweeping, so it is
     asserted rather than assumed. */
  check('The knocking is throttled, not fired off all at once',
    knocked.body.requests === 5 && knocked.body.tookMs >= 4 * THROTTLE_MS,
    `${knocked.body.requests} requests in ${knocked.body.tookMs}ms`);
  check('And never more than the cap in one press',
    knocked.body.requests <= knocked.body.cap && knocked.body.cap === CHECK_CAP);

  check('Nothing HaTi sent back comes through the Mapper',
    !JSON.stringify(knocked.body).includes('xxxxxxxxxx'), 'a response body reached the page');
  check('Only a size band is reported, never the content',
    said['GET /api/pulse'].size === 'tiny' && !('body' in said['GET /api/pulse']),
    JSON.stringify(said['GET /api/pulse']));
  check('The panel gets one sentence it can lead with',
    /doors are open/.test(knocked.body.summary || ''), knocked.body.summary);

  const after = await doorsCall('GET', '/api/public-check');
  check('The result is kept, so the page can show it again without knocking',
    after.body.last && after.body.last.requests === 5, JSON.stringify(after.body.last && after.body.last.requests));

  const again = await doorsCall('POST', '/api/public-check');
  const thrice = await doorsCall('POST', '/api/public-check');
  check('A third press inside the window is refused',
    again.status === 200 && thrice.status === 429, `${again.status} then ${thrice.status}`);

  /* A Mapper that does not know where HaTi is says so, rather than offering a
     button that cannot work. */
  const noSite = await get('/api/public-check');
  check('With no live site configured, the check says so plainly',
    noSite.body.available === false && /HATI_URL is not set/.test(noSite.body.reason || ''),
    JSON.stringify(noSite.body));
  const noSitePress = await post('/api/public-check');
  check('And pressing it anyway is refused with the reason',
    noSitePress.status === 409 && noSitePress.body.disabled === true, JSON.stringify(noSitePress.body));

  /* ---- the suite runs on every push ----
     A broken workflow file fails silently: GitHub simply never runs it, and
     the first anyone knows is months of unverified commits. There is no YAML
     library here — Express is the only runtime dependency and Playwright the
     only dev one — so this reads the small subset of YAML the file actually
     uses (nested mappings, sequences of mappings, plain scalars) and asserts
     the structure. It does not claim to validate YAML in general; it claims
     the file says what this project needs it to say. */
  console.log('\nThe suite runs on every push');

  function miniYaml(text) {
    const lines = text.split('\n')
      .map(l => l.replace(/\s+$/, ''))
      .filter(l => l.trim() && !/^\s*#/.test(l));
    let i = 0;

    const indentOf = l => l.length - l.trimStart().length;

    function block(indent) {
      // A sequence and a mapping cannot share a level, so the first line decides.
      if (/^-\s/.test(lines[i].trim())) {
        const out = [];
        while (i < lines.length && indentOf(lines[i]) === indent && /^-\s/.test(lines[i].trim())) {
          const rest = lines[i].trim().slice(2);
          const childIndent = indentOf(lines[i]) + 2;
          i++;
          const m = rest.match(/^([\w.-]+):\s*(.*)$/);
          if (!m) { out.push(rest); continue; }
          const item = {};
          item[m[1]] = m[2] === '' ? (i < lines.length && indentOf(lines[i]) > childIndent ? block(indentOf(lines[i])) : null) : scalar(m[2]);
          while (i < lines.length && indentOf(lines[i]) === childIndent) Object.assign(item, one(childIndent));
          out.push(item);
        }
        return out;
      }
      const out = {};
      while (i < lines.length && indentOf(lines[i]) === indent) Object.assign(out, one(indent));
      return out;
    }

    function one(indent) {
      const m = lines[i].trim().match(/^([\w.-]+):\s*(.*)$/);
      if (!m) throw new Error(`line ${i + 1} is neither a key nor a list item: ${lines[i]}`);
      i++;
      if (m[2] !== '') return { [m[1]]: scalar(m[2]) };
      if (i < lines.length && indentOf(lines[i]) > indent) return { [m[1]]: block(indentOf(lines[i])) };
      return { [m[1]]: null };
    }

    const scalar = v => v.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    return block(0);
  }

  const WF = path.join(ROOT, '.github', 'workflows', 'verify.yml');
  check('There is a workflow file at all', fs.existsSync(WF), WF);
  const wfText = fs.readFileSync(WF, 'utf8');
  check('It uses spaces throughout, which YAML requires', !/\t/.test(wfText));

  let wf = null;
  try { wf = miniYaml(wfText); } catch (e) { check('The workflow file parses', false, e.message); }
  if (wf) {
    check('The workflow file parses', true);
    check('It runs on both a push and a pull request',
      wf.on && 'push' in wf.on && 'pull_request' in wf.on, JSON.stringify(wf.on));
    check('It is allowed to read and nothing else',
      wf.permissions && wf.permissions.contents === 'read' && Object.keys(wf.permissions).length === 1,
      JSON.stringify(wf.permissions));

    const job = wf.jobs && wf.jobs.verify;
    check('There is a job that runs the verification', !!job, JSON.stringify(Object.keys(wf.jobs || {})));
    const steps = (job && job.steps) || [];
    const runs = steps.filter(s => s.run).map(s => s.run);
    check('It installs the dependencies', runs.includes('npm install'), runs.join(' | '));
    check('It fetches the browser the suite drives',
      runs.some(r => /playwright install/.test(r) && /chromium/.test(r)), runs.join(' | '));
    check('It runs the very command a person runs locally',
      runs.includes('npm run verify'), runs.join(' | '));

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check('And that command exists in package.json', typeof pkg.scripts.verify === 'string', JSON.stringify(pkg.scripts));
    check('It asks for the Node the project asks for',
      steps.some(s => s.with && String(s.with['node-version']) === '22'),
      JSON.stringify(steps.map(s => s.with).filter(Boolean)));

    const verifyStep = steps.find(s => s.run === 'npm run verify');
    check('The scan is given a GitHub token rather than left to the anonymous limit',
      verifyStep && verifyStep.env && /GITHUB_TOKEN/.test(Object.keys(verifyStep.env).join(',')),
      JSON.stringify(verifyStep && verifyStep.env));
    check('With a repository secret able to take over when the default is not enough',
      verifyStep && /HATI_SCAN_TOKEN/.test(JSON.stringify(verifyStep.env)),
      JSON.stringify(verifyStep && verifyStep.env));
  }
  check('The workflow says why the token is what it is',
    /HATI_SCAN_TOKEN/.test(wfText) && /read-only/.test(wfText));
  check('And it is written down in the README',
    /HATI_SCAN_TOKEN/.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')));

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
  if (troubleServer) troubleServer.kill();
  if (doorsServer) doorsServer.kill();
  if (spoofProxy) spoofProxy.close();
  if (stubHati) stubHati.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SPOOF_DATA, { recursive: true, force: true });
  fs.rmSync(TROUBLE_DATA, { recursive: true, force: true });
  fs.rmSync(TROUBLE_SOURCE, { recursive: true, force: true });
  fs.rmSync(DOORS_DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
