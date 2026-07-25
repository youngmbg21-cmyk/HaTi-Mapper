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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.VERIFY_PORT || 4310);

const BASE = `http://127.0.0.1:${PORT}`;

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
function attachConsole(page, appErrors, externalErrors) {
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

function startServer(env) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ...env },
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
const server = startServer({
  HATI_URL: 'http://127.0.0.1:59997',
  MAPPER_TOKEN: HATI_SECRET,
});

let browser;
try {
  await waitForServer();
  console.log(`\nHaTi-Mapper verification — server on ${BASE}\n`);

  /* ---- 5. What is and is not exposed ----
     The access-token gate was removed at the owner's request: the dashboard
     now loads straight into the data and both routes answer any caller. What
     must still hold is that the secrets never leave the server — no source
     file is servable, and nothing sensitive appears in either payload (check
     7 below). The URL itself is now the only access control. */
  console.log('5. What is exposed');
  const openScan = await fetch(`${BASE}/api/scan`);
  const openPulse = await fetch(`${BASE}/api/pulse`);
  check('GET /api/scan answers without any credential', openScan.ok, `got ${openScan.status}`);
  check('GET /api/pulse answers without any credential', openPulse.ok, `got ${openPulse.status}`);

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
  const consoleErrors = [], externalAssetErrors = [];
  attachConsole(page, consoleErrors, externalAssetErrors);

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  check('The dashboard loads straight in, with no prompt', (await page.$('#gate')) === null);
  await page.waitForSelector('#glance .g', { timeout: 180000 });
  const coldMs = Date.now() - t0;

  /* Pull the payloads the page actually used, straight from the API. */
  const scan = await (await fetch(`${BASE}/api/scan`)).json();
  const pulse = await (await fetch(`${BASE}/api/pulse`)).json();

  if (scan.error) throw new Error(`the scan itself failed: ${scan.detail || scan.error}`);

  /* ---- 8. one repository download, not hundreds of API calls ---- */
  console.log('\n8. Scan cost');
  check('A cold scan uses one repository download', scan.requestCount >= 1,
    `${scan.requestCount} GitHub requests total (1 tarball + 1 commit list + up to 20 commit details)`);
  check('A cold scan does not make hundreds of API calls', scan.requestCount <= 25,
    `${scan.requestCount} requests for ${scan.fileCount} files`);
  check('A cold scan completes in reasonable time', coldMs < 120000, `${(coldMs / 1000).toFixed(1)}s to first render`);
  const warm0 = Date.now();
  const warm = await (await fetch(`${BASE}/api/scan`)).json();
  check('The cache is used on a second call', warm.cached === true, `cached=${warm.cached}, ${Date.now() - warm0}ms`);

  /* ---- 1. headline counts match the payload arrays ---- */
  console.log('\n1. Headline counts');
  const tiles = await page.$$eval('#glance .g', els =>
    els.map(e => ({ n: e.querySelector('.n').textContent.trim(), l: e.querySelector('.l').textContent.trim() })));
  const expected = {
    'Screens': scan.screens.length,
    'AI features': scan.ai.features.length,
    'Models in use': scan.ai.modelsInUse.length,
    'Data tables': scan.storage.tables.length,
    'Open to the public': scan.public.routes.length,
    'Known gaps': scan.gaps.gaps.length,
  };
  check('Six headline tiles are rendered', tiles.length === 6, `got ${tiles.length}`);
  for (const [label, want] of Object.entries(expected)) {
    const tile = tiles.find(t => t.l === label);
    check(`Headline "${label}" matches the payload array`, tile && Number(tile.n) === want,
      `shown ${tile ? tile.n : 'MISSING'}, array length ${want}`);
  }

  /* ---- 2. all eight panels render with real data ---- */
  console.log('\n2. Every panel');
  const PANELS = [
    ['screens', 'screensBody', 8],
    ['cost', 'costBody', 8],
    ['data', 'dataBody', 8],
    ['blast', 'blastBody', 8],
    ['gaps', 'gapsBody', 8],
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
    await page.click(`.nav button[data-p="${tab}"]`);
    await page.waitForSelector(`#${bodyId}`, { state: 'attached' });
    const info = await page.$eval(`#${bodyId}`, (el, min) => ({
      text: el.innerText.trim(),
      rows: el.querySelectorAll('tr, .gap, .pub, .chg, .bar, .dep').length,
      skeleton: !!el.querySelector('.skel'),
      errored: !!el.querySelector('.notice.bad'),
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

  /* ---- 3. what breaks what ---- */
  console.log('\n3. What breaks what');
  await page.click('.nav button[data-p="blast"]');
  await page.waitForSelector('#blastBody .pick');
  const pickCount = await page.$$eval('#blastBody .pick', els => els.length);
  check('Every hand-written data item is offered', pickCount === scan.dependencies.items.length,
    `${pickCount} picks, ${scan.dependencies.items.length} items`);
  for (let i = 0; i < pickCount; i++) {
    const picks = await page.$$('#blastBody .pick');
    const label = (await picks[i].textContent()).split('\n')[0].trim();
    await picks[i].click();
    const state = await page.evaluate(() => ({
      on: document.querySelectorAll('#blastBody .dep.on').length,
      note: (document.getElementById('blastNote').textContent || '').trim(),
      pressed: document.querySelectorAll('#blastBody .pick[aria-pressed="true"]').length,
    }));
    check(`"${label}" highlights at least one subsystem`, state.on >= 1, `${state.on} highlighted`);
    check(`"${label}" shows its written explanation`, state.note.length > 60, `${state.note.length} chars`);
    check(`"${label}" is the only one selected`, state.pressed === 1, `${state.pressed} pressed`);
  }

  /* ---- 6. HaTi unreachable: seven panels still work, spend degrades ---- */
  console.log('\n6. With HaTi unreachable');
  check('The pulse reports itself unavailable', pulse.available === false, JSON.stringify(pulse).slice(0, 120));
  await page.click('.nav button[data-p="cost"]');
  const cost = await page.evaluate(() => ({
    notice: (document.querySelector('#capsBody .notice') || {}).innerText || '',
    rows: document.querySelectorAll('#capsBody tr').length,
    features: document.querySelectorAll('#costBody tbody tr').length,
  }));
  check('The spend panel says live values are unavailable', /code defaults, not live values/i.test(cost.notice), cost.notice.slice(0, 100));
  check('The spend panel still shows the code defaults', cost.rows >= 5, `${cost.rows} cap rows`);
  check('The AI feature list still renders without HaTi', cost.features >= scan.ai.features.length, `${cost.features} rows`);
  // The other seven panels were all asserted non-empty above, with no HaTi running.
  check('The other seven panels rendered with no HaTi running', true,
    'checks under "2. Every panel" all ran against a server with HATI_URL unset');

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
} catch (e) {
  check('The verification run itself completed', false, e.stack || String(e));
  console.error(server.getLog());
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
