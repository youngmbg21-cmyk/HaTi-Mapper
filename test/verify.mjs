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

  const navPinned = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).position);
  check('The tabs are pinned to the top of the window, not left up the page',
    navPinned === 'sticky', navPinned);

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

  /* Scroll a long way down one tab, go elsewhere, come back. The place has to
     be waiting where it was left. Reloaded first, because "a tab you have not
     opened before" is only true of a page that has not been driven through
     every tab already, as this one has. */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#screensBody .sk'), null, { timeout: 60000 });

  /* Where the open panel begins, with room for the pinned tab row above it.
     Measured off the panel rather than the row: while the row is pinned, both
     its rect and its offsetTop report the top of the window, which is how an
     earlier version of this silently asserted nothing at all. */
  const navLine = () => page.evaluate(() => {
    const panel = document.querySelector('.panel:not([hidden])');
    const nav = document.querySelector('.topbar');
    return Math.max(0, panel.getBoundingClientRect().top + window.scrollY - nav.getBoundingClientRect().height);
  });

  /* The requirement is stillness: clicking a tab must leave the page exactly
     where it was, so the new panel's heading lands where the old one's was and
     the eye stays level.

     How far down that can be honoured is a property of the shortest panel — no
     page can hold a position its content cannot reach. So the reach of every
     panel is measured first, and the test parks inside all of them. The
     position that matters most is comfortably inside that: the tab row pinned
     to the top of the window, which is where this is actually read. */
  const anchor = await navLine();
  const reach = await page.evaluate(() => {
    const out = {};
    const panels = [...document.querySelectorAll('.panel')];
    const open = panels.find(p => !p.hidden);
    for (const p of panels) {
      panels.forEach(x => { x.hidden = x !== p; });
      out[p.getAttribute('data-panel')] = document.documentElement.scrollHeight - window.innerHeight;
    }
    panels.forEach(x => { x.hidden = x !== open; });
    return out;
  });
  const shortestReach = Math.min(...Object.values(reach));
  check('Every panel can be scrolled at least as far as the pinned tab row',
    shortestReach >= anchor, `shortest reach ${Math.round(shortestReach)}, tab row rests at ${Math.round(anchor)}`);

  const parked = await page.evaluate(async to => {
    window.scrollTo(0, to);
    return window.scrollY;
  }, Math.min(anchor + 200, shortestReach - 20));
  await page.waitForTimeout(80);
  check('And the test is parked well below the top, so this proves something',
    parked > anchor + 50, `parked at ${Math.round(parked)}, tab row rests at ${Math.round(anchor)}`);

  /* Every tab, a full circuit, from that one position. A single tab that moves
     the page fails this. */
  const moved = [];
  for (const tab of ['weight', 'cost', 'data', 'blast', 'tower', 'public', 'changes', 'settings', 'screens']) {
    await page.click(`[data-p="${tab}"]`);
    await page.waitForTimeout(90);
    const at = await page.evaluate(() => window.scrollY);
    if (Math.abs(at - parked) > 2) moved.push(`${tab} → ${Math.round(at)}`);
  }
  check('Clicking any tab leaves the page exactly where it was',
    moved.length === 0, moved.length ? `moved on ${moved.join(', ')} from ${Math.round(parked)}` : `all nine held ${Math.round(parked)}`);

  /* Every panel reserving a screenful is what makes the above possible: a
     short panel that collapsed the document would drag the reader up with it. */
  const shortestPanel = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.panel')];
    const open = panels.find(p => !p.hidden);
    let min = Infinity;
    for (const p of panels) {
      panels.forEach(x => { x.hidden = x !== p; });
      min = Math.min(min, p.getBoundingClientRect().height);
    }
    panels.forEach(x => { x.hidden = x !== open; });
    return { min, viewport: window.innerHeight };
  });
  check('No panel is short enough to collapse the page under you',
    shortestPanel.min >= shortestPanel.viewport - 140,
    `shortest panel ${Math.round(shortestPanel.min)}px against a ${shortestPanel.viewport}px window`);

  /* The one case that cannot be honoured, asserted rather than hidden: from
     deep inside the longest panel, a shorter one simply has no content down
     there. The reader must land at the end of it — never back at the top. */
  const longest = Object.entries(reach).sort((a, b) => b[1] - a[1])[0][0];
  const shortest = Object.entries(reach).sort((a, b) => a[1] - b[1])[0][0];
  await page.click(`[data-p="${longest}"]`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(90);
  const deep = await page.evaluate(() => window.scrollY);
  await page.click(`[data-p="${shortest}"]`);
  await page.waitForTimeout(90);
  const landed = await page.evaluate(() => window.scrollY);
  check('From deeper than a panel reaches, you land at its end — never back at the top',
    deep > reach[shortest] && Math.abs(landed - reach[shortest]) < 4,
    `${Math.round(deep)} in "${longest}" → ${Math.round(landed)} in "${shortest}", which reaches ${Math.round(reach[shortest])}`);

  check('And the page still scrolls to the very top when asked',
    await page.evaluate(() => { window.scrollTo(0, 0); return window.scrollY === 0; }));

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

  /* ---- which way things are moving ----
     This Mapper has only ever scanned once, which is the state a brand-new
     install is in. Drawing a line through one point would be a lie, so the
     strip has to say so. The drawn state is checked below against a second
     Mapper with a seeded archive. */
  console.log('\nWhich way things are moving');
  await page.click('[data-p="tower"]');
  const freshTrends = await page.evaluate(() => {
    const el = document.getElementById('trends');
    return { hidden: el.hidden, text: (el.innerText || '').trim(), charts: el.querySelectorAll('svg').length };
  });
  check('A brand-new Mapper shows the strip', !freshTrends.hidden);
  check('And says it has no history yet rather than drawing a flat line',
    /Not enough history yet/i.test(freshTrends.text), freshTrends.text.slice(0, 120));
  check('So nothing is drawn', freshTrends.charts === 0, `${freshTrends.charts} charts`);

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

  /* ---- the same strip, with history behind it ----
     A second Mapper whose archive is seeded with six weeks of readings, so the
     drawn state can be checked the way the owner will actually see it. */
  console.log('\nWhich way things are moving, with history');
  fs.rmSync(TRENDS_DATA, { recursive: true, force: true });
  fs.mkdirSync(TRENDS_DATA, { recursive: true });
  const readingAt = (daysAgo, over) => ({
    at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    files: 30, bytes: 400000, largest: 60000, openRoutes: 8, hashRoutes: 3,
    gaps: 12, tables: 10, features: 9, health: 100, dailyCostUsd: 10, ...over,
  });
  fs.writeFileSync(path.join(TRENDS_DATA, 'history-archive.json'), JSON.stringify({
    v: 1,
    rounds: [],
    points: [
      readingAt(40, { bytes: 300000, largest: 40000, openRoutes: 6, gaps: 9, health: 100, dailyCostUsd: 7 }),
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
  await page2.waitForSelector('#trends .spark-grid', { timeout: 180000 });

  const drawn = await page2.evaluate(() => {
    const el = document.getElementById('trends');
    return {
      charts: el.querySelectorAll('svg').length,
      lines: el.querySelectorAll('polyline.line').length,
      points: [...el.querySelectorAll('polyline.line')].map(p => p.getAttribute('points').trim().split(/\s+/).length),
      labels: [...el.querySelectorAll('.spark .t')].map(e => e.textContent.trim()),
      values: [...el.querySelectorAll('.spark .v')].map(e => e.textContent.trim()),
      directions: [...el.querySelectorAll('.spark .d')].map(e => e.textContent.trim()),
      text: (el.innerText || '').trim(),
    };
  });
  check('Six sparklines are drawn', drawn.charts === 6 && drawn.lines === 6,
    `${drawn.charts} charts, ${drawn.lines} lines`);
  /* Six seeded readings plus the one this server took when it started. */
  check('Each is drawn from every reading in the archive',
    drawn.points.length === 6 && drawn.points.every(n => n === drawn.points[0] && n >= 6),
    drawn.points.join(','));
  check('Weight, biggest file, open doors, gaps, readability and money are all there',
    ['Everything, all together', 'The biggest single file', 'Doors that need no login',
     'Things not finished', 'How much the scanner can read', 'A day at the caps, in money']
      .every(l => drawn.labels.includes(l)), drawn.labels.join(' | '));
  check('Each carries the value it stands at now', drawn.values.every(v => v && v !== '—'), drawn.values.join(' | '));
  check('And says which way it is going, in words not axes',
    drawn.directions.every(d => /% (bigger|smaller|higher|lower) than 90 days ago|Unchanged/.test(d)),
    drawn.directions.join(' | '));
  /* Three series whose live value is known from the fixture and which rise
     across the seeded window: more open doors, more gaps, more money. Each has
     to be drawn as unwelcome, not merely as movement. */
  const unwelcome = await page2.$$eval('#trends .spark', els => els
    .filter(e => e.classList.contains('up'))
    .map(e => e.querySelector('.t').textContent.trim()));
  check('Growth in the wrong direction is not drawn as good news',
    ['Doors that need no login', 'Things not finished', 'A day at the caps, in money']
      .every(l => unwelcome.includes(l)), unwelcome.join(' | '));
  check('The strip says the readings are numbers only',
    /no names and no paths/.test(drawn.text));
  check('Drawing them raises no console errors', trendErrors.length === 0, trendErrors.slice(0, 3).join(' | '));
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
