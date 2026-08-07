/* HaTi-Mapper — headless verification.
 *
 * Drives the real front end against a real server with the pre-installed
 * Chromium and asserts the eight things that have to be true before this can
 * be called finished. It starts its own server on a spare port; nothing here
 * needs a deployed instance.
 *
 *   node test/verify.mjs
 *
 * Set GITHUB_TOKEN to avoid GitHub's 60-request unauthenticated hourly cap.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.VERIFY_PORT || 4310);

const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-verify-data');
fs.rmSync(DATA, { recursive: true, force: true });

/* A tripwire that has already gone off, seeded before the server starts.
   Nothing in a first-ever scan can trip one — there is no previous snapshot to
   compare against — so this is the only honest way to see the banner the way
   the owner would. */
const SEEDED_TRIP = {
  rule: 'openRoute',
  key: 'openRoute:GET /api/seeded',
  title: 'A door opened that needs no login',
  text: 'GET /api/seeded now answers without anyone logging in. If that was not deliberate, it is the most urgent thing on this page.',
  at: new Date().toISOString(),
  immediate: true,
};
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'prefs.json'), JSON.stringify({ tripped: [SEEDED_TRIP] }));

/* Pick whichever Chromium this image actually has, rather than the version
   Playwright's own download would have fetched. */
function chromiumPath() {
  const base = '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  for (const dir of fs.readdirSync(base)) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = path.join(base, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/* Console errors are split in two. Errors raised by the page's own code, and
   failures to load a resource from this origin, are the app's fault and must
   be zero. A failure to reach an external host — the Google Fonts stylesheet
   the design asks for — is a property of the network the test runs on, not of
   the app, so it is reported separately rather than counted. The page renders
   correctly without it: every font stack in the CSS falls back to a system
   face. */
function attachConsole(page, appErrors, externalErrors, cspViolations) {
  // A resource-load console error carries no reliable location, so the failed
  // request itself is what tells us which origin it belonged to.
  const failedExternal = [];
  page.on('requestfailed', r => {
    if (!r.url().startsWith(BASE)) failedExternal.push(`${r.url()} — ${(r.failure() || {}).errorText || 'failed'}`);
  });
  page.on('response', r => {
    if (r.status() >= 400 && !r.url().startsWith(BASE)) failedExternal.push(`${r.url()} — HTTP ${r.status()}`);
  });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const from = (m.location() && m.location().url) || '';
    /* A policy violation reads "Refused to …", not "Failed to load resource",
       so it would otherwise be filed as an ordinary app error. Captured first
       and separately, because it needs naming rather than counting. */
    if (cspViolations && /Content Security Policy/i.test(text)) cspViolations.push(text);
    const isResourceLoad = /Failed to load resource/i.test(text);
    if (from && !from.startsWith(BASE)) { externalErrors.push(`${from} — ${text}`); return; }
    if (isResourceLoad && failedExternal.length) { externalErrors.push(`${failedExternal.shift()} (${text})`); return; }
    appErrors.push(text);
  });
  page.on('pageerror', e => appErrors.push(String(e)));
}

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

function startServer(env, port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port || PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  child.getLog = () => log;
  return child;
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

/* ---------------------------------------------------------------- run */

/* HATI_URL points at a port with nothing on it, so this run verifies the
   "HaTi unreachable" path (check 6). MAPPER_TOKEN is a sentinel: it is a real
   secret the server holds, and check 7 asserts it never appears in anything
   the browser can see. */
const HATI_SECRET = 'sentinel-mapper-token-must-not-leak-9f3a';
const OWNER_EMAIL = 'verify@example.com';
const OWNER_PW = 'verifypass1';
/* A second Mapper, with an archive seeded before it starts, so the trend strip
   can be checked in the state it reaches after weeks of scanning. */
const TRENDS_PORT = PORT + 1;
const TRENDS_DATA = path.join(ROOT, '.tmp-trends-data');
let trendServer = null;

/* A third Mapper, pointed at a stand-in HaTi that answers each of its open
   doors differently, so the door check can be driven through the real button
   and every verdict seen on screen. */
const DOORS_PORT = PORT + 2;
const STUB_PORT = PORT + 3;
const DOORS_DATA = path.join(ROOT, '.tmp-verify-doors');
let doorsServer = null, stubHati = null;

const source = await hatiSource();
announce(source);
const server = startServer({
  HATI_URL: 'http://127.0.0.1:59997',
  MAPPER_TOKEN: HATI_SECRET,
  MAPPER_DATA: DATA,
  MAPPER_OWNER_EMAIL: OWNER_EMAIL,
  ...source.env,
});

let browser;
try {
  await waitForServer();
  console.log(`\nHaTi-Mapper verification — server on ${BASE}\n`);

  /* ---- 5. Nothing is readable without signing in ----
     The dashboard is behind an email-and-password login. Every route that
     returns data must refuse without a session, and the secrets must never
     leave the server whether signed in or not. */
  console.log('5. Locked without a login');
  for (const p of ['/api/scan', '/api/pulse', '/api/changes', '/api/ai/config']) {
    const r = await fetch(BASE + p);
    check(`${p} refuses without a session`, r.status === 401, `got ${r.status}`);
  }
  const statusOpen = await fetch(`${BASE}/api/auth/status`);
  const statusBody = await statusOpen.json();
  check('Only the status route answers without a session', statusOpen.ok);
  check('And it returns no dashboard data', !('screens' in statusBody) && !('ai' in statusBody), JSON.stringify(statusBody));

  /* The files holding the tokens must remain unreachable over HTTP. */
  for (const p of ['/server.mjs', '/lib/scan.mjs', '/lib/github.mjs', '/data/copy.js', '/package.json', '/render.yaml', '/.env']) {
    const r = await fetch(BASE + p);
    check(`${p} is not servable`, r.status === 404, `got ${r.status}`);
  }
  /* Only index.html and app.js may be fetched, and neither may carry a secret. */
  for (const p of ['/', '/app.js']) {
    const body = await (await fetch(BASE + p)).text();
    /* Each pattern requires a plausible key BODY, not just the prefix — the
       key-entry form legitimately shows "sk-ant-…" as placeholder text, and a
       test that flags its own instructions is a test that gets switched off. */
    const leaked = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}/.test(body)
      || body.includes(HATI_SECRET);
    check(`${p} contains no secret`, !leaked);
  }

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext();

  /* ---- the real run ---- */
  console.log('\n1, 2, 3, 4, 6. The dashboard');
  const page = await ctx.newPage();
  const consoleErrors = [], externalAssetErrors = [], cspViolations = [];
  attachConsole(page, consoleErrors, externalAssetErrors, cspViolations);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth:not([hidden])', { timeout: 20000 });
  check('An unclaimed Mapper asks you to set up an account', /Set up your account/i.test(await page.textContent('#authTitle')));
  check('No dashboard data is on the page before signing in', !(await page.isVisible('#app')));

  /* Claim the account through the real form, exactly as the owner would. */
  await page.fill('#authEmail', OWNER_EMAIL);
  await page.fill('#authPassword', OWNER_PW);
  await page.fill('#authConfirm', OWNER_PW);
  const t0 = Date.now();
  await page.click('#authGo');
  await page.waitForSelector('#towerBurn .bignum', { timeout: 180000 });
  const coldMs = Date.now() - t0;
  check('Signing in lands on the dashboard', await page.isVisible('#app'));

  /* Reuse the browser's session for the API assertions below. */
  const cookies = await ctx.cookies();
  const sessionCookie = cookies.filter(c => c.name === 'mapper_session')[0];
  check('The session is an httpOnly cookie', !!sessionCookie && sessionCookie.httpOnly === true,
    sessionCookie ? `httpOnly=${sessionCookie.httpOnly}` : 'no cookie');
  const authed = (p) => fetch(BASE + p, { headers: { Cookie: `mapper_session=${sessionCookie.value}` } });

  /* Pull the payloads the page actually used, straight from the API. */
  const scan = await (await authed('/api/scan')).json();
  const pulse = await (await authed('/api/pulse')).json();

  if (scan.error) throw new Error(`the scan itself failed: ${scan.detail || scan.error}`);

  /* ---- 8. one repository download, not hundreds of API calls ---- */
  console.log('\n8. Scan cost');
  if (source.mode === 'live') {
    check('A cold scan uses one repository download', scan.requestCount >= 1,
      `${scan.requestCount} GitHub requests total (1 tarball + 1 commit list + up to 20 commit details)`);
    check('A cold scan does not make hundreds of API calls', scan.requestCount <= 25,
      `${scan.requestCount} requests for ${scan.fileCount} files`);
    check('The scan says it read the real repository', scan.fixture === false, `fixture=${scan.fixture}`);
  } else {
    /* No GitHub, so the download itself cannot be measured. What can be
       asserted is that the stand-in was used and that the page says so
       rather than presenting it as the live product. */
    check('The scan says plainly that it read a stand-in', scan.fixture === true, `fixture=${scan.fixture}`);
    check('And the warning is carried in the payload',
      (scan.warnings || []).some(w => /stand-in for HaTi/i.test(w)), (scan.warnings || []).slice(0, 2).join(' | '));
    check('The stand-in produced a whole repository to read', scan.fileCount >= 20, `${scan.fileCount} files`);
  }
  check('A cold scan completes in reasonable time', coldMs < 120000, `${(coldMs / 1000).toFixed(1)}s to first render`);
  const warm0 = Date.now();
  const warm = await (await authed('/api/scan')).json();
  check('The cache is used on a second call', warm.cached === true, `cached=${warm.cached}, ${Date.now() - warm0}ms`);

  /* ---- 1. the control tower reads the same numbers the panels do ----
     The tower is a summary, so the one thing that must be true of it is that
     it never disagrees with the payload the tabs below are drawn from. */
  console.log('\n1. The control tower');
  const tower = await page.evaluate(() => {
    const t = id => (document.getElementById(id).innerText || '').trim();
    return {
      cards: ['towerBurn', 'towerCal', 'towerDoors', 'towerAttention', 'towerGrip', 'towerMap', 'towerWeight']
        .map(id => ({ id, text: t(id), loading: !!document.querySelector(`#${id} .sk`) })),
      doorsBig: (document.querySelector('#towerDoors .bignum') || {}).textContent || '',
      gripBig: (document.querySelector('#towerGrip .bub b') || {}).textContent || '',
      weightBig: (document.querySelector('#towerWeight .bignum') || {}).textContent || '',
      files: document.querySelectorAll('#towerWeight .filerow').length,
      days: document.querySelectorAll('#towerCal .d').length,
    };
  });
  for (const c of tower.cards) {
    check(`Tower card "${c.id}" rendered`, c.text.length > 10 && !c.loading, `${c.text.length} chars`);
  }
  check('The open-door count matches the payload',
    Number(tower.doorsBig) === scan.public.routes.length,
    `tower says ${tower.doorsBig}, payload has ${scan.public.routes.length}`);
  check('The grip figure matches the payload',
    tower.gripBig.trim() === scan.health.percent + '%',
    `tower says ${tower.gripBig}, payload says ${scan.health.percent}%`);
  check('The heaviest files are listed', tower.files >= 1 && tower.files <= 5, `${tower.files} rows`);
  check('The calendar draws a real month', tower.days >= 28, `${tower.days} day cells`);
  check('The total size is shown in KB', /\d+\s*KB/.test(tower.weightBig), tower.weightBig);

  /* ---- the warnings circle: it breathes, and it opens a popup ----
     The grip figure counts the scan's warnings, and the circle showing that
     count has to do two things: pulse for attention, and open the full list on
     click. The list also stays on its Settings card — the popup does not
     replace it — so both are checked. The fixture always raises at least the
     "stand-in" warning, so the circle is present in this run. */
  const warnCircle = await page.$('#towerGrip .gowarn');
  check('The grip card shows a warnings circle when the scan raised any', !!warnCircle,
    warnCircle ? 'present' : 'no .gowarn — did the fixture raise no warnings?');
  if (warnCircle) {
    const anim = await page.evaluate(() => {
      const el = document.querySelector('#towerGrip .gowarn');
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration };
    });
    check('The circle breathes rather than sitting still',
      anim.name === 'warnbreathe' && parseFloat(anim.dur) >= 1, `${anim.name} / ${anim.dur}`);

    /* With motion turned off it must not just stop dead as grey — it holds the
       red instead, so the warning still reads. */
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#towerGrip .gowarn'));
      return { name: cs.animationName, bg: cs.backgroundColor };
    });
    check('With reduced motion it holds the warning colour instead of pulsing',
      still.name === 'none' && still.bg === 'rgb(220, 38, 38)', `${still.name} / ${still.bg}`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    /* Closed to start, opens on click, holds the same warnings the payload
       carries, and the Settings card is left intact underneath. */
    check('The popup starts closed', await page.$eval('#warnPop', el => el.hidden));
    await warnCircle.click();
    await page.waitForSelector('#warnPop:not([hidden])', { timeout: 5000 });
    const pop = await page.evaluate(() => ({
      count: (document.getElementById('warnPopCount').textContent || '').trim(),
      items: document.querySelectorAll('#warnPopBody li').length,
      focusInside: document.getElementById('warnPop').contains(document.activeElement),
    }));
    check('Clicking the circle opens the popup with every warning',
      pop.items === scan.warnings.length && pop.items > 0,
      `${pop.items} shown, ${scan.warnings.length} in payload`);
    check('And the count in its header matches', /^\d+ warning/.test(pop.count), pop.count);
    check('Focus moves into the dialog', pop.focusInside);

    /* Escape closes it and does not also close anything behind it. */
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('warnPop').hidden, null, { timeout: 5000 });
    check('Escape closes the popup', await page.$eval('#warnPop', el => el.hidden));
    check('And the page is still on the control tower behind it',
      await page.$eval('.panel[data-panel="tower"]', el => !el.hidden));

    /* The Settings card still carries the same list — the popup is an addition,
       not a move. */
    await page.evaluate(() => document.querySelector('.tops [data-p="settings"]').click());
    await page.waitForFunction(() => !document.getElementById('scanWarnCard').hidden, null, { timeout: 5000 });
    const settingsWarns = await page.$$eval('#scanWarnBody li', els => els.length);
    check('The full warnings list is still on its Settings card too',
      settingsWarns === scan.warnings.length, `${settingsWarns} on the card, ${scan.warnings.length} in payload`);
    await page.evaluate(() => document.querySelector('[data-p="tower"]').click());
  }

  /* ---- 2. all eight panels render with real data ---- */
  console.log('\n2. Every panel');
  /* "Not finished" now lives on the Changes screen alongside last night's
     report, so its body is reached through that tab rather than its own. */
  const PANELS = [
    ['screens', 'screensBody', 8],
    ['cost', 'costBody', 8],
    ['data', 'dataBody', 8],
    ['blast', 'blastBody', 8],
    ['changes', 'gapsBody', 4],
    ['public', 'publicBody', 8],
    ['changes', 'changesBody', 4],
    ['weight', 'weightBody', 8],
  ];
  /* Numbers and strings that only ever existed in the hardcoded mockup. If any
     of them survives, something is still fake. */
  const MOCKUP_LEFTOVERS = [
    'scanned 25 Jul 2026, 14:02', '142 / 500', 'HATI_DEV=1', 'js/views/devmap.js',
    'Thirteen screens, six value streams', '500 requests', '50,000 chars',
    'Six files are past the comfortable line', 'Four things work without logging in',
  ];
  for (const [tab, bodyId, minRows] of PANELS) {
    await page.click(`[data-p="${tab}"]`);
    await page.waitForSelector(`#${bodyId}`, { state: 'attached' });
    const info = await page.$eval(`#${bodyId}`, (el, min) => ({
      text: el.innerText.trim(),
      rows: el.querySelectorAll('tr, .gline, .caprow, .knock2, .filerow, .dep2, .evrow').length,
      skeleton: !!el.querySelector('.sk'),
      errored: !!el.querySelector('.note.bad'),
    }), minRows);
    check(`Panel "${tab}" is not empty`, info.text.length > 40, `${info.text.length} chars of text`);
    check(`Panel "${tab}" is not still loading`, !info.skeleton);
    check(`Panel "${tab}" is not showing an error`, !info.errored);
    check(`Panel "${tab}" has at least ${minRows} rows of real data`, info.rows >= minRows, `${info.rows} rows`);
  }
  const wholePage = await page.evaluate(() => document.body.innerText);
  for (const leftover of MOCKUP_LEFTOVERS) {
    check(`No mockup value survives: "${leftover.slice(0, 40)}"`, !wholePage.includes(leftover));
  }

  /* ---- Settings and the assistant panel, driven through the real controls ----
     These are clicked rather than called, because the bug this guards against
     was a button that sent the wrong HTTP method: the route worked perfectly
     when called directly, and only the real button was broken. */
  console.log('\nSettings and the assistant panel');
  await page.click('[data-p="settings"]');
  await page.waitForSelector('#setKey');
  await page.fill('#setKey', 'sk-ant-' + 'a'.repeat(40));
  await page.click('#setKeySave');
  let keySaved = true;
  try { await page.waitForFunction(() => /Saved/.test(document.getElementById('setKeyState').textContent), null, { timeout: 15000 }); }
  catch (_) { keySaved = false; }
  check('Saving the AI key from Settings works', keySaved, await page.textContent('#setKeyState'));
  check('Only a last-four hint is shown back, never the key',
    !(await page.textContent('#setKeyState')).includes('aaaa' + 'aaaa'), await page.textContent('#setKeyState'));

  await page.click('#setKeyClear');
  let keyCleared = true;
  try { await page.waitForFunction(() => /Not set/.test(document.getElementById('setKeyState').textContent), null, { timeout: 15000 }); }
  catch (_) { keyCleared = false; }
  check('Removing the AI key from Settings works', keyCleared, await page.textContent('#setKeyState'));

  /* expand / shrink, and that the choice is remembered */
  await page.click('#askLaunch');
  await page.waitForSelector('#ask:not([hidden])');
  const widthOf = () => page.$eval('#ask', e => Math.round(e.getBoundingClientRect().width));
  const narrow = await widthOf();
  await page.click('#askExpand');
  await page.waitForTimeout(250);
  const wide = await widthOf();
  check('The assistant panel expands', wide > narrow + 100, `${narrow}px → ${wide}px`);
  check('Expanding flips the button to a shrink control',
    /Shrink/i.test(await page.getAttribute('#askExpand', 'title')), await page.getAttribute('#askExpand', 'title'));
  await page.click('#askExpand');
  await page.waitForTimeout(250);
  check('And shrinks back again', (await widthOf()) === narrow, `${await widthOf()}px`);
  await page.click('#askExpand');
  await page.waitForTimeout(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#towerBurn .bignum', { timeout: 180000 });
  await page.click('#askLaunch');
  await page.waitForTimeout(300);
  check('The expanded choice is remembered across a reload',
    await page.$eval('#ask', e => e.classList.contains('expanded')));

  /* clear history */
  await page.evaluate(() => document.getElementById('askClear').click());
  await page.waitForTimeout(300);
  check('Clearing an empty conversation says so rather than doing nothing',
    /Nothing to delete/i.test((await page.textContent('#toast').catch(() => '')) || ''),
    await page.textContent('#toast').catch(() => '(no toast)'));

  /* Escape shrinks an expanded panel before it closes it, so the key never
     loses a conversation you were only trying to make smaller. */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape shrinks an expanded panel rather than closing it',
    !(await page.$eval('#ask', e => e.classList.contains('expanded'))) && !(await page.$eval('#ask', e => e.hidden)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape again closes it', await page.$eval('#ask', e => e.hidden));

  /* ---- saying so while it works ----
     A question can sit for the better part of a minute while the assistant
     looks things up, and for a while this page had a marker for that with no
     styling behind it — three empty elements, drawn as nothing. The wait was
     indistinguishable from the panel having died. So the marker is asserted
     the way the reader meets it: is something actually painted, does it say
     what is happening, and does it go when the answer lands.

     The answer is intercepted and held open, because what is being checked is
     the wait itself. The key is set only so the panel offers its form rather
     than its key box; the request never reaches Anthropic. */
  console.log('\nSaying so while it works');
  await page.evaluate(() => fetch('/api/ai/config', {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-ant-' + 'z'.repeat(40) }),
  }));
  await page.route('**/api/chat', async route => {
    await new Promise(r => setTimeout(r, 6000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'Done.', sources: [] }) });
  });
  await page.click('#askLaunch');
  await page.waitForSelector('#askInput', { state: 'visible', timeout: 15000 });
  await page.fill('#askInput', 'What changed lately?');
  await page.click('#askSend');
  await page.waitForTimeout(600);

  const waiting = await page.evaluate(() => {
    const t = document.querySelector('#askFeed .typing');
    if (!t) return { there: false };
    const r = t.getBoundingClientRect(), dot = t.querySelector('i').getBoundingClientRect();
    const mine = document.querySelector('#askFeed .msg.me');
    return {
      there: true, w: Math.round(r.width), h: Math.round(r.height), dot: Math.round(dot.width),
      say: (t.querySelector('.say') || {}).textContent || '',
      live: t.getAttribute('aria-live'),
      mine: mine ? Math.round(mine.getBoundingClientRect().width) : 0,
    };
  });
  check('Asking a question puts something on screen straight away', waiting.there);
  check('And it is drawn rather than being an element with no styling',
    waiting.there && waiting.w > 60 && waiting.h > 20 && waiting.dot >= 4,
    `${waiting.w}x${waiting.h}, dot ${waiting.dot}px`);
  check('It says what is happening, not only three dots',
    /Reading your question/.test(waiting.say), waiting.say);
  check('A screen reader is told as well as shown', waiting.live === 'polite', String(waiting.live));
  check('Your own question is drawn as a message of yours', waiting.mine > 40, `${waiting.mine}px wide`);

  await page.waitForTimeout(4200);
  const stillGoing = await page.evaluate(() => (document.querySelector('#askFeed .typing .say') || {}).textContent || '');
  check('The wording moves on, so a long wait never reads as stalled',
    /Looking things up/.test(stillGoing), stillGoing);

  await page.waitForSelector('#askFeed .msg.bot .body', { timeout: 20000 });
  const answered = await page.evaluate(() => {
    const body = document.querySelector('#askFeed .msg.bot .body');
    return {
      typing: document.querySelectorAll('#askFeed .typing').length,
      bg: getComputedStyle(body).backgroundColor,
    };
  });
  check('The marker goes when the answer lands', answered.typing === 0, `${answered.typing} left`);
  check("And the answer is drawn in the assistant's own bubble",
    answered.bg !== 'rgba(0, 0, 0, 0)' && answered.bg !== 'transparent', answered.bg);

  await page.unroute('**/api/chat');

  /* ---- the panel does not look like the page under it ----
     The assistant floats over the dashboard and is built from the same card
     and tile tokens as everything beneath it, so it read as one more card.
     Its two ends are banded green to fix that, which is only worth anything if
     the band is actually a different colour from the page and the text on it
     is legible — in both themes, since a colour chosen against one of them is
     a colour untested against the other. Checked as ratios rather than by eye,
     because "it looked fine" is how the styling got lost the first time. */
  console.log('\nThe assistant does not blend into the page');
  const contrast = (fg, bg) => {
    const lum = c => {
      const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const theme of ['dark', 'light']) {
    /* Dispatched rather than clicked: the panel is open on top of the top
       bar, so a real click would land on the panel. */
    if (theme === 'light') { await page.evaluate(() => document.getElementById('themeBtn').click()); await page.waitForTimeout(300); }
    const p = await page.evaluate(() => {
      const cs = s => getComputedStyle(document.querySelector(s));
      return {
        headBg: cs('.ask-head').backgroundColor, title: cs('.ask-head h3').color,
        icon: cs('.ask-x').color,
        footBg: cs('.ask-foot').backgroundColor, note: cs('.ask-note').color,
        sendBg: cs('#askSend').backgroundColor, sendFg: cs('#askSend').color,
        inputBg: cs('#askInput').backgroundColor, inputFg: cs('#askInput').color,
        page: cs('body').backgroundColor, card: cs('.ask').backgroundColor,
      };
    });
    check(`In ${theme}, both ends of the panel are banded`,
      p.headBg === p.footBg && p.headBg !== p.page && p.headBg !== p.card,
      `head ${p.headBg}, foot ${p.footBg}, panel ${p.card}`);
    /* The field is the one thing that must not be part of the band — you have
       to be able to see where to type. */
    check(`In ${theme}, the text field keeps its own background`,
      p.inputBg !== p.footBg && contrast(p.inputBg, p.footBg) >= 3,
      `field ${p.inputBg} on ${p.footBg}, ${contrast(p.inputBg, p.footBg).toFixed(2)}:1`);
    check(`In ${theme}, the Ask button is visible against the band`,
      contrast(p.sendBg, p.footBg) >= 3,
      `${contrast(p.sendBg, p.footBg).toFixed(2)}:1`);
    for (const [what, fg, bg, want] of [
      ['the title', p.title, p.headBg, 4.5],
      ['the panel controls', p.icon, p.headBg, 3],
      ['the note under the field', p.note, p.footBg, 3],
      ['the Ask label', p.sendFg, p.sendBg, 4.5],
      ['what you type', p.inputFg, p.inputBg, 4.5],
    ]) {
      const r = contrast(fg, bg);
      check(`In ${theme}, ${what} is legible where it sits`, r >= want,
        `${r.toFixed(2)}:1, wanted ${want}:1`);
    }
  }
  await page.evaluate(() => document.getElementById('themeBtn').click());   // back to the theme the run started in
  await page.waitForTimeout(300);

  await page.evaluate(() => document.getElementById('askClear').click());
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* ---- 3. what breaks what ---- */
  console.log('\n3. What breaks what');
  await page.click('[data-p="blast"]');
  await page.waitForSelector('#blastBody .pick2');
  const pickCount = await page.$$eval('#blastBody .pick2', els => els.length);
  check('Every hand-written data item is offered', pickCount === scan.dependencies.items.length,
    `${pickCount} picks, ${scan.dependencies.items.length} items`);
  for (let i = 0; i < pickCount; i++) {
    const picks = await page.$$('#blastBody .pick2');
    const label = (await picks[i].textContent()).split('\n')[0].trim();
    await picks[i].click();
    const state = await page.evaluate(() => ({
      on: document.querySelectorAll('#blastBody .dep2.on').length,
      note: (document.getElementById('blastNote').textContent || '').trim(),
      pressed: document.querySelectorAll('#blastBody .pick2[aria-pressed="true"]').length,
    }));
    check(`"${label}" highlights at least one subsystem`, state.on >= 1, `${state.on} highlighted`);
    check(`"${label}" shows its written explanation`, state.note.length > 60, `${state.note.length} chars`);
    check(`"${label}" is the only one selected`, state.pressed === 1, `${state.pressed} pressed`);
  }

  /* ---- 6. HaTi unreachable: seven panels still work, spend degrades ---- */
  console.log('\n6. With HaTi unreachable');
  check('The pulse reports itself unavailable', pulse.available === false, JSON.stringify(pulse).slice(0, 120));
  await page.click('[data-p="cost"]');
  const cost = await page.evaluate(() => ({
    notice: (document.getElementById('capsLede') || {}).innerText || '',
    rows: document.querySelectorAll('#capsBody .caprow').length,
    features: document.querySelectorAll('#costBody tbody tr').length,
  }));
  check('The spend panel says live values are unavailable', /code defaults, not live values/i.test(cost.notice), cost.notice.slice(0, 100));
  check('The spend panel still shows the code defaults', cost.rows >= 5, `${cost.rows} cap rows`);
  check('The AI feature list still renders without HaTi', cost.features >= scan.ai.features.length, `${cost.features} rows`);
  // The other seven panels were all asserted non-empty above, with no HaTi running.
  check('The other seven panels rendered with no HaTi running', true,
    'checks under "2. Every panel" all ran against a server with HATI_URL unset');

  /* ---- how much the scanner could read ---- */
  console.log('\nHow much the scanner could read');
  await page.click('[data-p="tower"]');
  const health = await page.evaluate(() => {
    const el = document.getElementById('towerGrip');
    return {
      text: (el.innerText || '').trim(),
      big: (el.querySelector('.bub b') || {}).textContent || '',
      bubbles: el.querySelectorAll('.bub').length,
    };
  });
  check('The score is on the control tower', health.text.length > 20, health.text.slice(0, 90));
  check('It leads with the percentage', health.big.trim() === scan.health.percent + '%',
    `shows ${health.big}, payload says ${scan.health.percent}%`);
  check('It says how many facts that was, not just a percentage',
    health.text.includes(`${scan.health.resolved} of ${scan.health.attempts}`),
    `payload: ${scan.health.resolved} of ${scan.health.attempts}`);
  check('The misses are drawn beside the hits, so a bad score looks bad',
    health.bubbles >= 2, `${health.bubbles} bubbles`);

  /* ---- the page is readable, and keeps your place ----
     Two complaints from the owner, both about using the thing rather than
     about what it says: everything is set too small, and switching tabs threw
     away where you were reading. */
  console.log('\nReadable, and keeps your place');
  await page.click('[data-p="screens"]');
  const typeSizes = await page.evaluate(() => {
    const px = el => parseFloat(getComputedStyle(el).fontSize);
    const intro = document.querySelector('.panel:not([hidden]) .ph span');
    return {
      base: px(document.body),
      lede: intro ? px(intro) : 0,
      // The smallest text anywhere on a rendered panel — the fine print is
      // what actually decides whether the page is readable.
      smallest: Math.min(...[...document.querySelectorAll('.panel:not([hidden]) *')]
        .filter(el => el.textContent.trim() && !el.children.length).map(px)),
    };
  });
  check('The page is not set in fine print', typeSizes.base >= 14.5, `body is ${typeSizes.base}px`);
  check('Nor is the smallest text on a panel',
    typeSizes.smallest >= 9.5, `smallest rendered text is ${typeSizes.smallest}px`);
  check('The panel intros are readable too', typeSizes.lede >= 12, `${typeSizes.lede}px`);

  /* Asserted as the reader experiences it rather than as a CSS keyword: read
     to the end of the longest panel and the tabs must not have moved. Inside
     the frame that is structural — the row is outside the box that scrolls —
     and outside it the row is pinned. Either mechanism passes; a row that
     travels up the page does not.

     Not "the row is at zero": a tripwire that has gone off puts its banner
     above the tabs, which is where an alarm belongs. What may not happen is
     the row sliding away as you read. */
  const navPinned = await page.evaluate(async () => {
    const panel = document.querySelector('.panel:not([hidden])');
    const top = () => Math.round(document.querySelector('.topbar').getBoundingClientRect().top);
    const rest = top();
    panel.scrollTop = panel.scrollHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 60));
    const read = top();
    panel.scrollTop = 0;
    window.scrollTo(0, 0);
    return { rest, read };
  });
  check('The tabs are pinned to the top of the window, not left up the page',
    navPinned.read === navPinned.rest,
    `tab row rests at ${navPinned.rest}px, sits at ${navPinned.read}px once you have read to the end`);

  /* Raising the type pushed the nine tabs past the width of the column, and a
     sideways-scrolling strip slides the whole row when you click a tab near
     its end — so the tabs move out from under the cursor. Same complaint as
     the page jumping, different axis. They wrap instead. */
  const navRow = await page.evaluate(() => {
    const nav = document.querySelector('.pills');
    const btns = [...nav.querySelectorAll('button')];
    return {
      scrollsSideways: nav.scrollWidth > nav.clientWidth + 1,
      offRow: btns.filter(b => {
        const r = b.getBoundingClientRect(), n = nav.getBoundingClientRect();
        return r.left < n.left - 1 || r.right > n.right + 1;
      }).map(b => b.textContent.trim()),
      count: btns.length,
    };
  });
  check('The tab row never scrolls sideways', !navRow.scrollsSideways);
  check('Every tab is visible at once, so none of them moves when you click',
    navRow.offRow.length === 0 && navRow.count === 8,
    navRow.offRow.length ? `off the row: ${navRow.offRow.join(', ')}` : `all ${navRow.count} in view`);
  const gear = await page.$('.tops [data-p="settings"]');
  check('Settings is reachable from the top bar', !!gear);

  /* ---- what Settings says about whether the state is safe ----
     It used to say "written to this service's disk" whenever a write
     succeeded, which on a host that replaces the service's directory every
     deploy is true and beside the point. This run writes inside the
     repository — precisely the case that used to read as safe — so the page
     has to say so in words the owner can act on. */
  await page.click('.tops [data-p="settings"]');
  await page.waitForFunction(() => /\S/.test(document.getElementById('setStorageNote')?.textContent || ''), null, { timeout: 20000 });
  const storage = (await page.textContent('#setStorageNote')).trim();
  check('Settings does not claim a throwaway directory is permanent',
    !/written to this service’s disk\.?$/.test(storage) && /not a permanent disk/i.test(storage),
    storage.slice(0, 150));
  check('And says what actually happens to it, and what to do',
    /replaces? .*on every deploy/i.test(storage) && /MAPPER_DATA/.test(storage),
    storage.slice(0, 220));
  check('And names the directory it means, so the claim can be checked',
    !!(await page.$('#setStorageNote code')),
    (await page.textContent('#setStorageNote code').catch(() => '(none)')));

  /* Scroll a long way down one tab, go elsewhere, come back. The place has to
     be waiting where it was left. Reloaded first, because "a tab you have not
     opened before" is only true of a page that has not been driven through
     every tab already, as this one has. */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#screensBody .sk'), null, { timeout: 60000 });

  /* The requirement is stillness: clicking a tab must leave everything around
     the panel exactly where it was, so the new panel's heading lands where the
     old one's was and the eye stays level.

     The frame delivers that by construction rather than by correction. The
     document itself does not scroll at all — the tab row and the stamp are
     fixed parts of it and whichever panel is open scrolls between them. So
     the assertions are about the frame holding, not about a scroll position
     being restored: nothing to restore is a stronger guarantee than restoring
     it accurately. */
  const frame = await page.evaluate(() => ({
    locked: getComputedStyle(document.querySelector('.shell')).overflow === 'hidden',
    viewport: window.innerHeight,
  }));
  check('On a screen with the room for it, the app is a fixed frame', frame.locked,
    `${frame.viewport}px window`);

  /* Every tab, a full circuit. A single tab that scrolls the document, or that
     moves the row or the stamp by a pixel, fails this. */
  const before = await page.evaluate(() => ({
    nav: Math.round(document.querySelector('.topbar').getBoundingClientRect().top),
    foot: Math.round(document.querySelector('.footer').getBoundingClientRect().bottom),
  }));
  const drifted = [], scrolled = [];
  for (const tab of ['weight', 'cost', 'data', 'blast', 'tower', 'public', 'changes', 'settings', 'screens']) {
    await page.click(`[data-p="${tab}"]`);
    await page.waitForTimeout(90);
    const at = await page.evaluate(() => ({
      y: window.scrollY,
      over: document.documentElement.scrollHeight - window.innerHeight,
      nav: Math.round(document.querySelector('.topbar').getBoundingClientRect().top),
      foot: Math.round(document.querySelector('.footer').getBoundingClientRect().bottom),
    }));
    if (at.y !== 0 || at.over > 1) scrolled.push(`${tab} → y${at.y} over${at.over}`);
    if (at.nav !== before.nav || at.foot !== before.foot) drifted.push(`${tab} → nav ${at.nav}, foot ${at.foot}`);
  }
  check('No tab makes the page itself scroll', scrolled.length === 0, scrolled.join(', '));
  check('Clicking any tab leaves the row and the stamp exactly where they were',
    drifted.length === 0,
    drifted.length ? drifted.join(', ') : `all nine held nav ${before.nav}, foot ${before.foot}`);

  /* A panel long enough to scroll keeps its own place. Each panel is its own
     scrolling box, so leaving one and coming back lands where it was left —
     without any code having to remember a number. */
  const kept = await page.evaluate(async () => {
    const go = n => document.querySelector(`[data-p="${n}"]`).click();
    const panel = n => document.querySelector(`.panel[data-panel="${n}"]`);
    /* Whichever panel has the most below its fold, so this proves something. */
    const names = [...document.querySelectorAll('.panel')].map(p => p.getAttribute('data-panel'));
    let best = null;
    for (const n of names) {
      go(n);
      const p = panel(n);
      const over = p.scrollHeight - p.clientHeight;
      if (!best || over > best.over) best = { name: n, over };
    }
    if (best.over < 60) return { skipped: true, best };
    go(best.name);
    panel(best.name).scrollTop = 50;
    const parked = panel(best.name).scrollTop;
    go('tower');
    await new Promise(r => setTimeout(r, 60));
    go(best.name);
    return { name: best.name, parked, landed: panel(best.name).scrollTop };
  });
  check('A panel you scrolled is where you left it when you come back',
    !kept.skipped && kept.parked === kept.landed,
    kept.skipped ? `no panel scrolls at this size` : `"${kept.name}" parked ${kept.parked}, landed ${kept.landed}`);

  /* And the tower, the one panel that must never scroll at all. */
  const towerFits = await page.evaluate(() => {
    document.querySelector('[data-p="tower"]').click();
    const p = document.querySelector('.panel[data-panel="tower"]');
    return { over: p.scrollHeight - p.clientHeight, tiles: p.querySelectorAll('.card, .cal').length };
  });
  check('The control tower fits its frame with nothing below the fold',
    towerFits.over <= 1 && towerFits.tiles === 7,
    `${towerFits.over}px over, ${towerFits.tiles} tiles`);
  await page.click('[data-p="screens"]');

  /* ---- what each bulky file actually is ----
     A path is an address, not an answer: it tells a developer where to look
     and the owner nothing. Every row has to lead with what the file IS, and
     the panel has to explain its own units rather than assuming KB is
     common knowledge. */
  console.log('\nWhat the bulky files are');
  await page.click('[data-p="weight"]');
  await page.waitForSelector('#weightBody tbody tr', { timeout: 20000 });
  const fileRows = await page.evaluate(() => [...document.querySelectorAll('#weightBody tbody tr')].map(el => ({
    name: (el.querySelector('td b') || {}).textContent || '',
    path: (el.querySelector('.codechip') || {}).textContent || '',
    says: (el.querySelector('.subnum') || {}).textContent || '',
    big: !!el.querySelector('.badge.gold'),
    fill: (el.querySelector('td span[style*="width"]') || {}).getAttribute
      ? el.querySelector('td span[style*="width"]').getAttribute('style') : '',
  })));
  check('Every file is listed as a thing, not only as a path',
    fileRows.length === scan.weight.files.length && fileRows.every(r => r.name.trim().length > 2),
    `${fileRows.length} rows, ${fileRows.filter(r => !r.name.trim()).length} unnamed`);
  check('And each says in a sentence what it is for',
    fileRows.every(r => r.says.trim().length > 12),
    (fileRows.find(r => r.says.trim().length <= 12) || {}).path || 'all described');
  check('The biggest file is named as the engine room, from its own route count',
    fileRows[0].name === 'The engine room' && /all \d+ of them/.test(fileRows[0].says),
    `${fileRows[0].name} — ${fileRows[0].says.slice(0, 70)}`);
  check('A file behind a screen borrows that screen’s own words',
    fileRows.some(r => /^The .+ screen$/.test(r.name)),
    fileRows.filter(r => /screen$/.test(r.name)).map(r => r.name).slice(0, 3).join(' | '));
  check('The path is still there for whoever wants it',
    fileRows.every(r => /\.js$/.test(r.path.trim())), fileRows[0].path);
  check('The bars still draw', fileRows.every(r => /width:\s*[\d.]+%/.test(r.fill || '')), fileRows[0].fill);
  check('Files past the line are marked as past it',
    fileRows.filter(r => r.big).length === scan.weight.overThreshold,
    `${fileRows.filter(r => r.big).length} of ${scan.weight.overThreshold}`);

  const weightText = await page.textContent('#weightBody');
  check('The panel explains what a KB is rather than assuming it',
    /printed pages of code/.test(weightText));
  check('And says what the colouring means, in words',
    /outgrown comfortable/.test(weightText));
  check('No row is described by a path alone',
    !/^\s*js\/views\//m.test(await page.$eval('#weightBody tbody tr td b', el => el.textContent)));

  /* ---- draft a fix prompt ----
     The button has to be on the findings themselves, where the owner is
     looking when they decide something needs doing. The endpoint behind it is
     driven end to end in test/chat-loop.mjs, against a stand-in model. */
  console.log('\nDraft a fix prompt');
  const fixButtons = {};
  for (const [tab, kind] of [['cost', 'ai-unused'], ['changes', 'gap'], ['weight', 'file-size'], ['weight', 'orphan']]) {
    await page.click(`[data-p="${tab}"]`);
    await page.waitForTimeout(120);
    fixButtons[kind] = await page.$$eval(`button[data-fix="${kind}"]`, els =>
      els.map(e => e.getAttribute('data-id')).filter(Boolean));
  }
  check('A paid endpoint nothing calls offers to draft one',
    fixButtons['ai-unused'].length >= 1, fixButtons['ai-unused'].join(', ') || 'none');
  check('So does every gap the documents admit to',
    fixButtons.gap.length >= scan.gaps.gaps.length, `${fixButtons.gap.length} of ${scan.gaps.gaps.length}`);
  check('So does every name published and never used',
    fixButtons.orphan.length === scan.weight.orphans.length,
    `${fixButtons.orphan.length} of ${scan.weight.orphans.length}`);
  check('And the button carries the real identifier, not a row number',
    scan.weight.orphans.every(o => fixButtons.orphan.includes(o.name)),
    fixButtons.orphan.slice(0, 3).join(', '));
  check('A file under the line is not offered one — there is nothing to fix',
    fixButtons['file-size'].length === scan.weight.overThreshold,
    `${fixButtons['file-size'].length} buttons, ${scan.weight.overThreshold} files over the line`);

  /* ---- a tower with no history behind it ----
     This Mapper has only ever scanned once, which is the state a brand-new
     install is in. Drawing a line through one point would be a lie, so the
     tiles that draw one have to say so instead. The drawn state is checked
     below against a second Mapper with a seeded archive. */
  console.log('\nA tower with no history behind it');
  await page.click('[data-p="tower"]');
  const freshTower = await page.evaluate(() => ({
    burn: (document.querySelector('#towerBurn') || {}).innerText || '',
    lines: document.querySelectorAll('#towerBurn .chartwrap').length,
    bars: document.querySelectorAll('#towerDoors .bars').length,
    /* The figures that do not need history must still be there. */
    big: (document.querySelector('#towerBurn .bignum') || {}).textContent || '',
  }));
  check('A brand-new Mapper says it has no history yet rather than drawing a flat line',
    /at least three scans/i.test(freshTower.burn), freshTower.burn.slice(-120));
  check('So no spend line is drawn', freshTower.lines === 0, `${freshTower.lines} charts`);
  check('And no door history is drawn', freshTower.bars === 0, `${freshTower.bars} bar rows`);
  check('While the figures that need no history are still shown', /\d/.test(freshTower.big), freshTower.big);

  /* ---- what it costs to run ---- */
  console.log('\nWhat it costs to run');
  await page.click('[data-p="cost"]');
  await page.waitForSelector('#costBody table');
  const costPanel = await page.textContent('#costBody');
  check('The spend panel now shows money, not just counts', /\$\d/.test(costPanel), costPanel.slice(0, 80));
  check('With a per-use figure for every feature',
    (costPanel.match(/if one person hits the cap/g) || []).length >= scan.ai.features.length - 1,
    `${(costPanel.match(/if one person hits the cap/g) || []).length} rows priced`);
  check('And a whole-day ceiling', /A whole day, at the limits the code sets/.test(costPanel));
  check('The honesty label is on the page, not just in the payload',
    /rough ceiling, not a bill/.test(costPanel));
  check('So is when the prices were last checked', /Prices last checked/.test(costPanel));

  /* ---- tripwires ---- */
  console.log('\nTripwires');
  const banner = await page.evaluate(() => {
    const el = document.getElementById('tripped');
    return { hidden: el.hidden, text: (el.innerText || '').trim(), count: el.querySelectorAll('.trip').length };
  });
  check('A rule that has gone off is pinned to the top of the page', !banner.hidden && banner.count === 1,
    `hidden=${banner.hidden}, ${banner.count} banners`);
  check('It says what happened in the owner\'s own words',
    /now answers without anyone logging in/.test(banner.text), banner.text.slice(0, 120));
  check('And it sits above everything else on the page',
    await page.evaluate(() => {
      const t = document.getElementById('tripped').getBoundingClientRect().top;
      const g = document.querySelector('.topbar').getBoundingClientRect().top;
      return t < g;
    }));

  await page.click('[data-p="settings"]');
  await page.waitForSelector('#watchRules .rule');
  const rules = await page.$$eval('#watchRules .rule', els => els.map(e => ({
    say: e.querySelector('.bd b').innerText.trim(),
    on: e.querySelector('.toggle').getAttribute('aria-pressed') === 'true',
  })));
  check('Every rule is offered on the Settings tab', rules.length === 5, `${rules.length} rules`);
  check('Each one is phrased as an instruction', rules.every(r => /^Tell me/.test(r.say)), rules[0]?.say);
  check('The two dangerous ones are armed out of the box',
    rules.filter(r => r.on).length === 2, `${rules.filter(r => r.on).length} on`);

  await page.click('#watchRules .toggle[data-rule="fileSize"]');
  await page.waitForFunction(
    () => document.querySelector('#watchRules .toggle[data-rule="fileSize"]').getAttribute('aria-pressed') === 'true',
    null, { timeout: 15000 });
  check('A rule can be armed through the real button', true, 'fileSize now on');
  check('And arming it reveals the number it uses',
    await page.$eval('#watchRules input[data-th="fileSize"]', i => !i.disabled && Number(i.value) === 100),
    await page.$eval('#watchRules input[data-th="fileSize"]', i => i.value));

  /* Dismissing has to actually clear it, not just hide it locally. */
  await page.click('#tripped button[data-key]');
  await page.waitForFunction(() => document.getElementById('tripped').hidden, null, { timeout: 15000 });
  const afterDismiss = await (await authed('/api/watch')).json();
  check('Dismissing clears it on the server, not just on screen',
    afterDismiss.tripped.length === 0, JSON.stringify(afterDismiss.tripped));

  /* ---- last night ---- */
  console.log('\nLast night');
  await page.click('[data-p="changes"]');
  await page.waitForFunction(() => !document.querySelector('#digestBody .sk'), null, { timeout: 20000 });
  const digestCard = (await page.textContent('#digestBody')).trim();
  check('The "Last night" card renders', digestCard.length > 40, `${digestCard.length} chars`);
  check('And it is not an error', !(await page.$('#digestBody .note.bad')));

  /* ---- one word, one meaning ----
     Two different things were both called "changes": what the Mapper observed
     by comparing its own scans, and how many times someone saved work. The
     tower's calendar counts the first, this card was printing the second under
     the same word, and the two sat on screen contradicting each other while
     both were right. It also taught the assistant the wrong vocabulary, which
     then told the owner the dashboard was wrong.

     So "changes" is reserved for what the Mapper observed. Saves are code
     updates, here and in the emailed digest. */
  const wording = await page.evaluate(() => {
    const commitBlock = document.querySelector('#digestBody .commits');
    return {
      heading: (commitBlock?.querySelector('h5')?.textContent || '').trim(),
      shaTitle: commitBlock?.querySelector('.commit2 .h')?.getAttribute('title') || '',
      badge: (document.getElementById('digestBadge')?.textContent || '').trim(),
      /* The card listing the git log, on the same screen. */
      panelHeading: [...document.querySelectorAll('.panel[data-panel="changes"] .chead h3')]
        .map(h => h.textContent.trim()),
      foot: (document.querySelector('#digestBody')?.textContent || ''),
    };
  });
  check('The numbered list of saves is called code updates, not changes',
    /code updates?, in the order they happened/.test(wording.heading), wording.heading);
  check('And nothing in that heading calls them changes',
    !/change/i.test(wording.heading), wording.heading);
  check('A save\'s reference number is labelled a code update',
    /code update/.test(wording.shaTitle), wording.shaTitle);
  check('The git-log card is named for what it holds',
    wording.panelHeading.includes('Code updates'), wording.panelHeading.join(' | '));
  /* The badge counted observed changes and saves added together and called the
     total "changes" — the single number most directly at odds with the
     calendar. It may say "changes" only about the ones actually observed. */
  check('The badge does not call saves changes',
    !/change/i.test(wording.badge) || /code update|·/.test(wording.badge) || wording.badge === 'busy night',
    wording.badge);
  check('Where the text explains the git log, it says code updates',
    !/The changes above come straight from/.test(wording.foot),
    (wording.foot.match(/The .{0,18} above come straight from/) || ['(not shown)'])[0]);

  /* The night's changes are numbered in the order the work happened, so the
     card reads as a story rather than a pile. Story order is the assertion
     that matters: number 1 has to be the oldest, not the newest. */
  const numbered = await page.evaluate(() => [...document.querySelectorAll('#digestBody .commit2')]
    .map(el => ({
      n: el.querySelector('.n').textContent.trim(),
      text: el.querySelector('.t').textContent.trim(),
      sha: el.querySelector('.h').textContent.trim(),
    })));
  check('Every change in the night is numbered', numbered.length >= 3, `${numbered.length} rows`);
  check('Numbered from one, with no gaps',
    numbered.every((r, i) => r.n === String(i + 1)), numbered.map(r => r.n).join(','));
  check('Numbered in the order the work happened, oldest first',
    numbered[0].text === 'Add the clause deviation summary to reports' &&
    numbered[numbered.length - 1].text === 'Speed up the register table on large portfolios',
    `${numbered[0].text} → ${numbered[numbered.length - 1].text}`);
  check('Each carries its reference number without it crowding the sentence',
    numbered.every(r => /^[0-9a-f]{7}$/.test(r.sha)), numbered.map(r => r.sha).join(','));
  check('And the day they happened is stated, not just "since midnight"',
    /\d{1,2} \w{3}/.test(await page.textContent('#digestBody .commits .day')),
    await page.textContent('#digestBody .commits .day'));

  /* "0 scans" printed under a list of changes reads as broken. The footer has
     to separate GitHub's record from the Mapper's own observations. */
  const digestFoot = (await page.textContent('#digestBody .foot')).trim();
  check('A count of zero is explained rather than printed bare',
    !/\b0 (scans|looks)\b/.test(digestFoot), digestFoot);
  check('The footer says which half came from where',
    /straight from GitHub’s record/.test(digestFoot) && /not taken a look yet/.test(digestFoot),
    digestFoot);

  console.log('\nBeing told about things');
  await page.click('[data-p="settings"]');
  await page.waitForSelector('#setDigest');
  check('Morning summaries start switched off',
    (await page.textContent('#setDigest')).trim() === 'Off', await page.textContent('#setDigest'));
  check('And the page says why it cannot send any, with no provider configured',
    /no email provider is set up/i.test(await page.textContent('#setDigestState')),
    await page.textContent('#setDigestState'));
  await page.click('#setDigest');
  await page.waitForFunction(() => document.getElementById('setDigest').textContent.trim() === 'On', null, { timeout: 15000 });
  check('The toggle switches on through the real button', true, 'button now reads On');
  check('Switched on without a provider, it says so rather than pretending',
    /nothing will be sent/i.test(await page.textContent('#setDigestState')),
    await page.textContent('#setDigestState'));
  await page.click('#setDigest');
  await page.waitForFunction(() => document.getElementById('setDigest').textContent.trim() === 'Off', null, { timeout: 15000 });

  /* ---- how far back the change log will look ---- */
  console.log('\nLooking further back than 72 hours');
  await page.click('[data-p="changes"]');
  await page.waitForSelector('#watchRange button');
  const rangeAsks = [];
  page.on('request', r => { if (r.url().includes('/api/changes')) rangeAsks.push(r.url()); });
  await page.click('#watchRange button[data-h="720"]');
  await page.waitForFunction(() => !document.querySelector('#watchBody .sk'), null, { timeout: 20000 });
  check('Choosing 30 days asks the server for 30 days', rangeAsks.some(u => /hours=720/.test(u)), rangeAsks.join(' '));
  check('And the chosen range is the one shown as chosen',
    await page.$eval('#watchRange button[data-h="720"]', b => b.getAttribute('aria-pressed')) === 'true');
  check('The panel says which window it is describing',
    /last 30 days/.test(await page.textContent('#watchLede')), await page.textContent('#watchLede'));
  await page.click('#watchRange button[data-h="72"]');
  await page.waitForFunction(() => !document.querySelector('#watchBody .sk'), null, { timeout: 20000 });
  check('And it goes back to 72 hours', /last 72 hours/.test(await page.textContent('#watchLede')),
    await page.textContent('#watchLede'));

  /* ---- an empty log is not the same as a quiet HaTi ----
     This card used to answer an empty list with "the Mapper has looked N times
     and found HaTi unchanged each time — that is a good sign, not a broken
     page". Two problems, both of them the page reassuring the owner about
     something it had not established.

     The count was the snapshot count, and a snapshot only exists when
     something DID change — so it could not see the looks that found nothing,
     which are exactly the ones that sentence is about. And "a good sign" is
     only true with enough looks behind it: two looks finding nothing and two
     hundred looks finding nothing are opposite facts.

     This run has looked once or twice, so it is the thin case. */
  const empty = (await page.textContent('#watchBody')).trim();
  const lede = (await page.textContent('#watchLede')).trim();
  if (/Nothing has moved/.test(empty)) {
    check('An empty log does not call itself a good sign on a thin sample',
      !/good sign/.test(empty) && /too few looks to call this quiet/.test(empty),
      empty.slice(0, 200));
    check('It says the Mapper only looks when the page is opened',
      /looks when you open this page/.test(empty) && /no schedule/.test(empty),
      empty.slice(0, 240));
    check('And that an empty list may mean nobody has opened it',
      /nobody has opened the Mapper since HaTi last changed/.test(empty), empty.slice(0, 260));
  } else {
    check('The log has entries, so the empty-state wording is not on screen', true, 'skipped');
  }
  check('The card says when it last looked, not "watching since"',
    /The Mapper last looked/.test(lede) && !/Watching since/i.test(lede), lede);

  /* ---- is this what's live? ----
     This run has no HaTi, so the only state reachable here is the honest "I
     can't tell". The other two are asserted against lib/drift.mjs in
     test/auth.mjs, where both hashes can be supplied. */
  console.log('\nIs this what\'s live?');
  const drift = await page.evaluate(() => {
    const el = document.getElementById('drift');
    return { hidden: el.hidden, cls: el.className, text: (el.innerText || '').trim() };
  });
  check('The badge is shown', !drift.hidden);
  check('With HaTi unreachable it says it cannot tell', /Can’t tell whether this is what’s live/.test(drift.text), drift.text);
  check('And it is drawn as neither good nor bad news', /\bunknown\b/.test(drift.cls) && !/\bok\b|\bwarn\b/.test(drift.cls), drift.cls);
  check('The pulse payload carries the verdict', pulse.drift && pulse.drift.state === 'unknown', JSON.stringify(pulse.drift));

  /* ---- what the page is allowed to load ---- */
  console.log('\nContent-Security-Policy');
  const csp = (await fetch(BASE + '/')).headers.get('content-security-policy') || '';
  check('The page is served with a Content-Security-Policy', /default-src 'none'/.test(csp), csp.slice(0, 60) || '(none)');
  check('Only this service may supply a script, and never inline',
    /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
  check('Inline styles are allowed, because the markup genuinely uses them',
    /style-src[^;]*'unsafe-inline'/.test(csp), csp);
  check('Google Fonts is the only outside host the page may reach',
    /style-src[^;]*fonts\.googleapis\.com/.test(csp) && /font-src[^;]*fonts\.gstatic\.com/.test(csp) &&
    !/connect-src[^;]*https:\/\//.test(csp), csp);
  check('The whole session raised no policy violation', cspViolations.length === 0,
    cspViolations.slice(0, 3).join(' | '));

  /* ---- 4. console errors ---- */
  console.log('\n4. Console');
  check('Zero console errors across the whole session', consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | '));
  if (externalAssetErrors.length) {
    console.log(`        (${externalAssetErrors.length} external asset load failure(s), not the app's code, not counted:`);
    [...new Set(externalAssetErrors)].slice(0, 3).forEach(e => console.log(`         ${e}`));
    console.log('        )');
  }

  /* ---- 7. nothing sensitive in either payload ---- */
  console.log('\n7. Nothing sensitive crosses either route');
  const combined = JSON.stringify({ scan, pulse });
  const LEAK_PATTERNS = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'an email address'],
    [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'an Anthropic API key'],
    [/\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'a GitHub token'],
    [/\bKES\s?[\d,]+(?:\.\d+)?|\bUSD\s?[\d,]+(?:\.\d+)?|[£$€]\s?[\d,]{4,}/g, 'a monetary value'],
    [new RegExp(HATI_SECRET, 'g'), "HaTi's MAPPER_TOKEN"],
    [/"(?:counterparty|partyEmail|signerEmail|signatory|ownerName|userName)"\s*:\s*"[^"]+"/g, 'a party or user name'],
    [/\bBearer\s+\S+/g, 'a bearer credential'],
  ];
  for (const [re, what] of LEAK_PATTERNS) {
    const hits = combined.match(re) || [];
    check(`No ${what} in the scan or pulse payload`, hits.length === 0,
      hits.length ? `found: ${[...new Set(hits)].slice(0, 3).join(', ')}` : '');
  }
  /* The word "counterparty" legitimately appears as a *column name* and as a
     field name in the hand-written dependency map. That is schema, not data —
     assert it never appears as a value. */
  const counterpartyValues = (combined.match(/"counterparty"\s*:\s*"[^"]{2,}"/g) || []);
  check('"counterparty" appears only as a column name, never as a value',
    counterpartyValues.length === 0, counterpartyValues.slice(0, 2).join(', '));
  check('No file contents from HaTi are echoed into the payload',
    !combined.includes('sk-ant') && !/-----BEGIN/.test(combined));

  /* ---- rescan is real ---- */
  console.log('\nRescan');
  const stampBefore = await page.textContent('#stamp');
  const refreshHits = [];
  page.on('request', r => { if (r.url().includes('/api/scan')) refreshHits.push(r.url()); });
  await page.click('#rescan');
  await page.waitForFunction(
    (before) => {
      const s = document.getElementById('stamp');
      const b = document.getElementById('rescan');
      return s && b && !b.disabled && s.textContent !== before && !/scanning/i.test(s.textContent);
    },
    stampBefore, { timeout: 180000 });
  check('Rescan calls the refresh route', refreshHits.some(u => u.includes('refresh=1')), refreshHits.join(' '));
  const stampAfter = await page.textContent('#stamp');
  check('Rescan updates the timestamp', stampAfter !== stampBefore, `"${stampBefore}" -> "${stampAfter}"`);
  check('Rescan leaves no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await page.screenshot({ path: path.join(ROOT, 'test', 'verified.png'), fullPage: true }).catch(() => {});
  await page.close();

  /* ---- the tower with history behind it ----
     A second Mapper whose archive is seeded with six weeks of readings. The
     measurement series has no card of its own — it is read by four of the
     tower's tiles — so this is where those tiles are seen in the state they
     reach after weeks of scanning, rather than the empty one a first run
     shows. It is also where the tower is measured against the frame, because
     a full tower is the one that would overflow if anything is going to. */
  console.log('\nThe tower, with history behind it');
  fs.rmSync(TRENDS_DATA, { recursive: true, force: true });
  fs.mkdirSync(TRENDS_DATA, { recursive: true });
  const readingAt = (daysAgo, over) => ({
    at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    files: 30, bytes: 400000, largest: 60000, openRoutes: 8, hashRoutes: 3,
    gaps: 12, tables: 10, features: 9, health: 100, dailyCostUsd: 10, ...over,
  });
  /* Rounds inside the month the calendar draws, plus one well outside it. The
     tile's figure counts events, and it counts only this month's — so a seed
     with both tells a correct count apart from "everything in the log" and
     from the zero a wrong field name produces. */
  const monthDay = d => new Date(new Date().getFullYear(), new Date().getMonth(), d, 9, 0, 0).toISOString();
  const someEvents = n => Array.from({ length: n }, (_, i) => ({ kind: 'test', text: `something moved ${i}` }));
  const today = new Date().getDate();
  const MONTH_ROUNDS = [
    { at: monthDay(1), commit: 'aaa1111', events: someEvents(4) },
    { at: monthDay(Math.max(1, Math.min(today - 1, 27))), commit: 'bbb2222', events: someEvents(5) },
    { at: monthDay(today), commit: 'ccc3333', events: someEvents(3) },
  ];
  const MONTH_EVENTS = 12;
  const OUTSIDE_ROUND = { at: new Date(Date.now() - 40 * 864e5).toISOString(), commit: 'ddd4444', events: someEvents(7) };

  fs.writeFileSync(path.join(TRENDS_DATA, 'history-archive.json'), JSON.stringify({
    v: 1,
    rounds: [OUTSIDE_ROUND, ...MONTH_ROUNDS],
    points: [
      /* The oldest reading's grip is deliberately below what the scan finds
         now, so the tile has a real change to report rather than falling
         through to its "unchanged" branch and asserting nothing. */
      readingAt(40, { bytes: 300000, largest: 40000, openRoutes: 6, gaps: 9, health: 88, dailyCostUsd: 7 }),
      readingAt(33, { bytes: 320000, largest: 44000, openRoutes: 6, gaps: 10, health: 99, dailyCostUsd: 7.5 }),
      readingAt(26, { bytes: 351000, largest: 49000, openRoutes: 7, gaps: 10, health: 97, dailyCostUsd: 8 }),
      readingAt(19, { bytes: 372000, largest: 53000, openRoutes: 7, gaps: 11, health: 96, dailyCostUsd: 9 }),
      readingAt(12, { bytes: 390000, largest: 57000, openRoutes: 8, gaps: 12, health: 94, dailyCostUsd: 9.5 }),
      readingAt(2, { bytes: 420000, largest: 62000, openRoutes: 9, gaps: 13, health: 92, dailyCostUsd: 11 }),
    ],
  }));

  trendServer = startServer({
    MAPPER_DATA: TRENDS_DATA, MAPPER_OWNER_EMAIL: OWNER_EMAIL,
    HATI_URL: '', MAPPER_TOKEN: '', ...source.env,
  }, TRENDS_PORT);
  const trendsBase = `http://127.0.0.1:${TRENDS_PORT}`;
  let trendsUp = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${trendsBase}/api/health`)).ok) { trendsUp = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  check('A second Mapper started on a seeded archive', trendsUp);

  const page2 = await ctx.newPage();
  const trendErrors = [], trendExternal = [], trendCsp = [];
  attachConsole(page2, trendErrors, trendExternal, trendCsp);
  await page2.goto(trendsBase, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#auth:not([hidden])', { timeout: 20000 });
  await page2.fill('#authEmail', OWNER_EMAIL);
  await page2.fill('#authPassword', OWNER_PW);
  await page2.fill('#authConfirm', OWNER_PW);
  await page2.click('#authGo');
  await page2.waitForSelector('#towerBurn .chartwrap svg', { timeout: 180000 });

  const drawn = await page2.evaluate(() => ({
    /* The spend line: one filled area and one stroked line, both built from
       every reading in the archive. */
    burnPaths: document.querySelectorAll('#towerBurn .chartwrap svg path').length,
    burnChip: (document.querySelector('#towerBurn .chip') || {}).textContent || '',
    /* The door count, one bar per reading, capped at seven. */
    bars: document.querySelectorAll('#towerDoors .bars .bcol').length,
    /* The two tiles that put the oldest reading into a sentence. */
    grip: (document.querySelector('#towerGrip .subnum') || {}).textContent || '',
    weight: (document.querySelector('#towerWeight .subnum') || {}).textContent || '',
    /* Days the archive says were scanned, marked on the month. */
    scanned: document.querySelectorAll('#towerCal .d.scan, #towerCal .d.hot').length,
  }));
  check('The spend line is drawn once there are readings', drawn.burnPaths === 2,
    `${drawn.burnPaths} paths`);
  check('And is labelled with where it stands now', /\$/.test(drawn.burnChip), drawn.burnChip);
  check('The door count is drawn as a bar per reading', drawn.bars >= 2 && drawn.bars <= 7,
    `${drawn.bars} bars`);
  check('Scanner grip says what it was at the start of the log',
    /Was \d+% at the start of the log/.test(drawn.grip), drawn.grip.slice(0, 120));
  check('The total size says which way it moved over the log',
    /(grew|shrank) [\d.]+ ?[KM]B over the log/.test(drawn.weight), drawn.weight.slice(0, 120));
  check('The calendar marks the days the archive was scanned', drawn.scanned >= 1,
    `${drawn.scanned} days marked`);

  /* The figure under the month. It reads the rounds' `events`, and only those
     dated inside the month above it — the two ways this has been wrong. */
  const monthCount = await page2.evaluate(() => ({
    count: ((document.querySelector('#towerCal .foot .v') || {}).textContent || '').trim(),
    label: ((document.querySelector('#towerCal .foot .l') || {}).textContent || '').trim(),
    moved: document.querySelectorAll('#towerCal .d.hot').length,
  }));
  check(`The calendar counts this month's changes, not zero`,
    monthCount.count === `${MONTH_EVENTS} changes`, `tile says "${monthCount.count}"`);
  check('And says the figure is this month, matching the month it draws',
    /this month/.test(monthCount.label), monthCount.label);
  check('A round from outside the month is counted on neither',
    monthCount.moved === MONTH_ROUNDS.length, `${monthCount.moved} days marked as moved`);

  /* ---- the tower is one screen, and stays one screen ----
     The whole point of the control tower is that it is taken in at a glance,
     which it cannot be if any of it is below the fold. So on a screen with
     the room for the frame, nothing about it may scroll: not the page, not
     the panel, and not any tile that holds a fixed list. Three shapes of
     screen are checked, because a layout that fits one and not the others
     fits none of them. */
  for (const size of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    await page2.setViewportSize(size);
    await page2.waitForTimeout(250);
    const fit = await page2.evaluate(() => {
      const panel = document.querySelector('.panel[data-panel="tower"]');
      const over = [...panel.querySelectorAll('.card, .cal')]
        .filter(c => c.scrollHeight - c.clientHeight > 1)
        .map(c => (c.id || c.className) + ' by ' + (c.scrollHeight - c.clientHeight) + 'px');
      return {
        page: document.documentElement.scrollHeight - window.innerHeight,
        panel: panel.scrollHeight - panel.clientHeight,
        over,
        /* Every tile must still be drawn — fitting by rendering nothing is
           not fitting. */
        tiles: panel.querySelectorAll('.card, .cal').length,
      };
    });
    const px = `${size.width}×${size.height}`;
    check(`At ${px} the page itself does not scroll`, fit.page <= 1, `${fit.page}px over`);
    check(`At ${px} the tower does not scroll`, fit.panel <= 1, `${fit.panel}px over`);
    check(`At ${px} no tile is cut off`, fit.over.length === 0, fit.over.join(' | '));
    check(`At ${px} all seven tiles are drawn`, fit.tiles === 7, `${fit.tiles} tiles`);
  }
  check('Drawing the tower raises no console errors', trendErrors.length === 0, trendErrors.slice(0, 3).join(' | '));
  check('And no policy violations', trendCsp.length === 0, trendCsp.slice(0, 2).join(' | '));
  await page2.close();

  /* ---- knocking on the doors, through the real button ----
     Everywhere else on this page the answer is "what the code says". This is
     the one place it is "what the live site does", so it is driven the way the
     owner drives it: press the button, wait, read what came back. The
     stand-in HaTi below answers each open door differently so all four
     verdicts appear on screen at once. */
  console.log('\nKnocking on the doors');
  stubHati = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>HaTi</title>');
      if (url === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      if (url === '/api/status') return res.writeHead(401).end('{"error":"sign in"}');           // guarded, though the code says otherwise
      if (url === '/api/pulse') return res.writeHead(200).end('{"leak":true}');                  // hands data over, though the code says it checks a secret
      if (url === '/api/advice/rates') return req.socket.destroy();                              // answers nothing at all
      res.writeHead(404).end('{}');
    });
    srv.listen(STUB_PORT, () => resolve(srv)).on('error', reject);
  });

  fs.rmSync(DOORS_DATA, { recursive: true, force: true });
  doorsServer = startServer({
    MAPPER_DATA: DOORS_DATA, MAPPER_OWNER_EMAIL: OWNER_EMAIL,
    HATI_URL: `http://127.0.0.1:${STUB_PORT}`, MAPPER_TOKEN: '', ...source.env,
  }, DOORS_PORT);
  const doorsBase = `http://127.0.0.1:${DOORS_PORT}`;
  let doorsUp = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${doorsBase}/api/health`)).ok) { doorsUp = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  check('A third Mapper started, pointed at a running HaTi', doorsUp);

  const page3 = await ctx.newPage();
  const doorErrors = [], doorExternal = [], doorCsp = [];
  attachConsole(page3, doorErrors, doorExternal, doorCsp);
  await page3.goto(doorsBase, { waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('#auth:not([hidden])', { timeout: 20000 });
  await page3.fill('#authEmail', OWNER_EMAIL);
  await page3.fill('#authPassword', OWNER_PW);
  await page3.fill('#authConfirm', OWNER_PW);
  await page3.click('#authGo');
  await page3.waitForSelector('#app:not([hidden])', { timeout: 180000 });
  await page3.click('[data-p="public"]');
  await page3.waitForSelector('#doorsGo:not([disabled])', { timeout: 30000 });

  const beforePress = await page3.$eval('#doorsState', el => el.textContent.trim());
  check('The button says what pressing it will do, before it is pressed',
    /Not asked yet/.test(beforePress) && /at most 30/.test(beforePress) && /half a second apart/.test(beforePress),
    beforePress);
  check('And nothing has been sent to the live site yet',
    (await page3.$eval('#doorsBody', el => el.innerHTML)) === '');

  await page3.click('#doorsGo');
  await page3.waitForSelector('#doorsBody .knock2', { timeout: 60000 });
  /* The throttle means the last row lands seconds after the first, so wait for
     the run to finish rather than for the first row to appear. */
  await page3.waitForFunction(() => !document.getElementById('doorsGo').disabled, null, { timeout: 60000 });

  const knocked = await page3.evaluate(() => {
    const rows = [...document.querySelectorAll('#doorsBody .knock2')].map(el => ({
      verdict: el.querySelector('.badge').textContent.trim(),
      cls: el.className,
      address: el.querySelector('.codechip').textContent.trim(),
      says: [...el.querySelectorAll('.d')].map(d => d.textContent.trim()).join(' '),
    }));
    return { rows, text: document.getElementById('doorsBody').innerText.trim() };
  });

  const verdictOf = a => (knocked.rows.find(r => r.address === a) || {}).verdict;
  check('A door the code says is open, and is, shows as written',
    verdictOf('GET /health') === 'as written', verdictOf('GET /health'));
  check('A door the live site guards shows as wanting a login',
    verdictOf('GET /api/status') === 'wants login', verdictOf('GET /api/status'));
  check('A door that hands data over shows as having done so',
    verdictOf('GET /api/pulse') === 'gave data', verdictOf('GET /api/pulse'));
  check('A door that never answered shows as unanswered, not as fine',
    verdictOf('GET /api/advice/rates') === 'no answer', verdictOf('GET /api/advice/rates'));
  check('The two surprises are drawn as surprises, not as ordinary rows',
    ['GET /api/status', 'GET /api/pulse'].every(a =>
      /surprise/.test((knocked.rows.find(r => r.address === a) || {}).cls || '')),
    knocked.rows.map(r => `${r.address}=${r.cls}`).join(' | '));
  check('Anything that would have written data is shown as left alone, with the reason',
    knocked.rows.some(r => r.address === 'POST /api/advice/request' &&
      r.verdict === 'left alone' && /would write data/.test(r.says)),
    JSON.stringify(knocked.rows.find(r => /advice\/request/.test(r.address))));
  check('And the panel says what it did, in plain English',
    /plain request/.test(knocked.text) && /nothing of HaTi’s is on this screen/.test(knocked.text),
    knocked.text.slice(-220));
  check('No response body from the live site reaches the page',
    !knocked.text.includes('leak'), knocked.text.slice(0, 200));
  check('Knocking raises no console errors', doorErrors.length === 0, doorErrors.slice(0, 3).join(' | '));
  check('And no policy violations', doorCsp.length === 0, doorCsp.slice(0, 2).join(' | '));
  await page3.close();
} catch (e) {
  check('The verification run itself completed', false, e.stack || String(e));
  console.error(server.getLog());
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  if (trendServer) trendServer.kill();
  if (doorsServer) doorsServer.kill();
  if (stubHati) stubHati.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(TRENDS_DATA, { recursive: true, force: true });
  fs.rmSync(DOORS_DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
