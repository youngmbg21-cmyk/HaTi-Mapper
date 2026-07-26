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
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';

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
} catch (e) {
  check('The login test itself completed', false, e.stack || String(e));
  console.error(log.slice(-2000));
} finally {
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
