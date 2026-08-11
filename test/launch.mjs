/* HaTi-Mapper — the launch checklist, tested.
 *
 *   node test/launch.mjs
 *
 * Two halves.
 *
 * The first is pure arithmetic against lib/launch.mjs with contexts made up on
 * the spot, and it is the more important of the two. The whole value of that
 * file is one promise — THE NEEDLE CANNOT SAY SOMETHING THE GATES DENY — and a
 * promise like that is worth nothing unless something checks it on every
 * combination rather than on the two that were tried by hand. So the last
 * check in this half walks a few thousand tick combinations and asserts the
 * needle and the verdict agree in every one of them.
 *
 * The second half starts a real server and a real browser, because a checklist
 * that computes correctly and does not draw, or draws and does not save, is
 * not a checklist.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';
import { evaluateLaunch, ITEMS, TICKABLE, DEMO_MARK, LIVE_MARK } from '../lib/launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LAUNCH_PORT || 4520);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-launch-data');
const OWNER = 'owner@example.com';
const PW = 'launchpass1';
const STUB_PORT = PORT + 1;
const HATI_SECRET = 'launch-test-secret';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();

/* Every owner-answered item, ticked today. The Mapper-answered ones cannot be
   ticked and are settled by the context instead. */
const allTicked = (at = new Date().toISOString()) =>
  Object.fromEntries([...TICKABLE].map(id => [id, { done: true, at }]));

/* A context in which every single thing the Mapper checks for itself passes.
   Built once and then spoiled one field at a time, so a check that fails says
   which field it was rather than "something in here". */
const perfectCtx = () => ({
  scan: {
    repo: 'youngmbg21-cmyk/mkataba-clm',
    fixture: false,
    health: { percent: 97, warnings: 0 },
    public: { routes: [] },
    gaps: { gaps: [], ranked: true, severityCounts: { high: 0, medium: 1, low: 2, unstated: 0 } },
  },
  pulse: { available: true, drift: { state: 'match' } },
  doorCheck: { at: new Date().toISOString(), results: [{ verdict: 'as-expected' }] },
  prefs: { digestEmail: true, watch: { aiRequests: { on: true, threshold: 150 } } },
  storage: { writable: true, mounted: true, path: '/var/data' },
  email: { configured: true, ownerEmail: OWNER },
  canWatchLiveUsage: true,
  ticks: allTicked(),
});

console.log('\n1. The arithmetic');

/* ---- knowing nothing ---- */
{
  const L = evaluateLaunch({ ticks: {} });
  check('Knowing nothing about HaTi, the answer is "not ready to demo"',
    L.verdict === 'not-demo', `verdict ${L.verdict}, needle ${L.needle}`);
  check('And the needle sits behind the demo post rather than at nought',
    L.needle < DEMO_MARK, `needle ${L.needle}, demo post ${DEMO_MARK}`);
  check('Nothing counts as done when nothing has been established',
    L.counts.done === 0, `${L.counts.done} of ${L.counts.total}`);
  check('Every item the Mapper answers reports "can\'t tell" or "not done", never "done"',
    L.items.filter(i => i.how === 'mapper').every(i => !i.done),
    L.items.filter(i => i.how === 'mapper' && i.done).map(i => i.id).join(', ') || 'none claimed done');
}

/* ---- everything true ---- */
{
  const L = evaluateLaunch(perfectCtx());
  check('With every item satisfied, the answer is "ready to go live"',
    L.verdict === 'live', `verdict ${L.verdict}, ${L.counts.done} of ${L.counts.total} done`);
  check('And the needle is past the live post',
    L.needle > LIVE_MARK, `needle ${L.needle}, live post ${LIVE_MARK}`);
  check('And nothing is outstanding for either gate',
    L.counts.demoOpen === 0 && L.counts.liveOpen === 0,
    `${L.counts.demoOpen} demo, ${L.counts.liveOpen} live`);
}

/* ---- the promise: one open item pens the needle in ---- *
   This is the check the whole file exists for. Twenty-one of twenty-two done
   is 95% by arithmetic, and 95% next to an open door reads as "basically
   there". It must not be allowed to. */
{
  const ctx = perfectCtx();
  ctx.scan.public.routes = [{ path: '/api/contracts' }];   // one live-gate item open
  const L = evaluateLaunch(ctx);
  check('One outstanding live item stops the needle short of the live post',
    L.needle < LIVE_MARK, `needle ${L.needle} with raw arithmetic at ${L.raw}`);
  check('Even though the arithmetic alone would have put it past',
    L.raw > LIVE_MARK, `raw ${L.raw}, needle ${L.needle}`);
  check('And the verdict says demo, not live',
    L.verdict === 'demo', L.verdict);
  check('The headline says what is left rather than how far along it is',
    /1 thing still stand/.test(L.headline), L.headline);
}

{
  const ctx = perfectCtx();
  delete ctx.ticks['walked-it'];                            // one demo-gate item open
  const L = evaluateLaunch(ctx);
  check('One outstanding demo item stops the needle short of the demo post',
    L.needle < DEMO_MARK, `needle ${L.needle} with raw arithmetic at ${L.raw}`);
  check('And a demo item blocks the launch as well as the demo',
    L.counts.liveOpen >= 1 && L.verdict === 'not-demo',
    `${L.counts.liveOpen} live open, verdict ${L.verdict}`);
}

/* ---- "can't tell" is not "fine" ---- */
{
  const ctx = perfectCtx();
  ctx.pulse = null;                                         // the Mapper cannot reach HaTi
  const L = evaluateLaunch(ctx);
  const live = L.items.find(i => i.id === 'knows-live');
  check('An item the Mapper cannot settle reports "can\'t tell"',
    live.state === 'unknown', live.state);
  check('And "can\'t tell" does not open a gate',
    !live.done && L.verdict !== 'live', `done=${live.done}, verdict ${L.verdict}`);
  check('And it is counted separately, so it can be told from a plain "no"',
    L.counts.cantTell >= 1, `${L.counts.cantTell} unmeasurable`);
}

/* ---- a tick goes stale ---- */
{
  const stale = ITEMS.filter(i => i.staleAfterDays);
  check('Several owner-answered items are only good for a while',
    stale.length >= 4, stale.map(i => `${i.id}:${i.staleAfterDays}d`).join(', '));

  const ctx = perfectCtx();
  ctx.ticks = allTicked(ago(120));                          // every tick four months old
  const L = evaluateLaunch(ctx);
  const gone = L.items.filter(i => i.state === 'stale');
  check('A tick older than its life stops counting',
    gone.length === stale.length, `${gone.length} of ${stale.length} went stale`);
  check('And says how long ago it was ticked rather than just failing',
    gone.every(i => /120 days ago/.test(i.detail || '')), gone[0] && gone[0].detail);
  check('And a stale tick does not open a gate',
    L.verdict !== 'live', `verdict ${L.verdict}`);

  const fresh = evaluateLaunch({ ...perfectCtx(), ticks: allTicked(ago(3)) });
  check('A tick inside its life still counts, and says how long it has left',
    fresh.verdict === 'live' && /Good for another/.test(
      fresh.items.find(i => i.id === 'data-on-disk').detail || ''),
    fresh.items.find(i => i.id === 'data-on-disk').detail);
}

/* ---- the backup items exist and are gated where they belong ---- */
{
  const L = evaluateLaunch(perfectCtx());
  const code = L.items.find(i => i.id === 'code-on-disk');
  const data = L.items.find(i => i.id === 'data-on-disk');
  check('"A copy of the code is on your own computer" blocks even a demo',
    code && code.gate === 'demo', code && code.gate);
  check('"A copy of the live data is on your own computer" blocks going live',
    data && data.gate === 'live', data && data.gate);
  check('Both say why a repository is not a backup, in plain English',
    /not a backup/.test(code.why) && /has ever seen it/.test(data.why),
    code.why.slice(0, 60) + ' … ' + data.why.slice(0, 60));
  check('And both carry the steps to actually do it',
    (code.steps || []).length >= 4 && (data.steps || []).length >= 4,
    `${(code.steps || []).length} and ${(data.steps || []).length} steps`);
}

/* ---- the promise, across every combination ---- *
   Hand-picked cases prove the cases somebody thought of. This walks the space.
   Each round ticks a random subset of the owner's items against a random
   spoiling of the Mapper's, and asserts the three things that must hold
   whatever the mixture: the needle agrees with the verdict, a gate is open
   only when nothing behind it is outstanding, and the counts add up. */
{
  const SPOILERS = [
    c => { c.scan.fixture = true; },
    c => { c.scan.health.percent = 61; },
    c => { c.pulse = null; },
    c => { if (c.pulse) c.pulse.drift = { state: 'different', message: 'x' }; },
    c => { c.storage.mounted = false; },
    c => { c.scan.public.routes = [{ path: '/a' }]; },
    c => { c.doorCheck = null; },
    c => { c.scan.gaps.severityCounts.high = 2; },
    c => { c.prefs.watch.aiRequests.on = false; },
    c => { c.email.configured = false; },
  ];
  const tickable = [...TICKABLE];
  let bad = null, rounds = 0;

  /* A plain counter rather than a random draw, so a failure names a case that
     can be reproduced by hand. 4096 covers every subset of the ten spoilers
     four times over, against a rotating set of ticks. */
  for (let n = 0; n < 4096 && !bad; n++) {
    const ctx = perfectCtx();
    SPOILERS.forEach((sp, i) => { if (n & (1 << i)) sp(ctx); });
    ctx.ticks = Object.fromEntries(tickable
      .filter((_, i) => (n >> (i % 12)) & 1)
      .map(id => [id, { done: true, at: new Date().toISOString() }]));

    const L = evaluateLaunch(ctx);
    rounds++;

    const demoOK = L.counts.demoOpen === 0;
    const liveOK = L.counts.liveOpen === 0;
    const expected = !demoOK ? 'not-demo' : !liveOK ? 'demo' : 'live';

    const needleAgrees =
      expected === 'not-demo' ? L.needle < DEMO_MARK
        : expected === 'demo' ? (L.needle > DEMO_MARK && L.needle < LIVE_MARK)
          : L.needle > LIVE_MARK;

    if (L.verdict !== expected || !needleAgrees ||
        L.counts.done + L.items.filter(i => !i.done).length !== L.counts.total ||
        L.counts.liveOpen < L.counts.demoOpen) {
      bad = { n, verdict: L.verdict, expected, needle: L.needle, counts: L.counts };
    }
  }
  check('Across every combination, the needle never crosses a post that is still shut',
    !bad, bad ? `case ${bad.n}: verdict ${bad.verdict}, expected ${bad.expected}, needle ${bad.needle}` : `${rounds} combinations`);
}

/* ---- the shape of the list itself ---- */
{
  const L = evaluateLaunch(perfectCtx());
  check('Every item belongs to a group that is drawn',
    L.items.every(i => L.groups.some(g => g.id === i.group)),
    L.items.filter(i => !L.groups.some(g => g.id === i.group)).map(i => i.id).join(', ') || 'all placed');
  check('Every item states a gate the page knows how to label',
    L.items.every(i => ['demo', 'live', 'after'].includes(i.gate)));
  check('Every item says why it matters, not only what it is',
    L.items.every(i => (i.why || '').length > 40));
  check('Every item the owner answers carries the steps to do it',
    L.items.filter(i => i.how === 'you').every(i => (i.steps || []).length >= 3),
    L.items.filter(i => i.how === 'you' && (i.steps || []).length < 3).map(i => i.id).join(', ') || 'all have steps');
  check('No item the Mapper measures offers a tick box',
    L.items.filter(i => i.how === 'mapper').every(i => !TICKABLE.has(i.id)));
  check('Nothing on the list mentions a file path or a command the owner did not ask for',
    L.items.every(i => !/\.mjs|\bfunction\b|=>/.test(i.title + i.why)),
    L.items.filter(i => /\.mjs|\bfunction\b|=>/.test(i.title + i.why)).map(i => i.id).join(', ') || 'plain throughout');
}

/* ==================================================================== */
/*  2. The server and the page                                           */
/* ==================================================================== */

fs.rmSync(DATA, { recursive: true, force: true });
const source = await hatiSource();
announce(source);

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

/* A stand-in HaTi that answers the read-only pulse. Without one the Mapper
   cannot see live usage at all, so the AI-requests tripwire correctly reports
   "can't tell" and offers nothing to press — which is right, and would leave
   the arm-it-from-the-row behaviour untested. */
const stubHati = await new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/api/pulse') return res.writeHead(404).end('{}');
    if (req.headers.authorization !== `Bearer ${HATI_SECRET}`) return res.writeHead(401).end('{}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      caps: { aiRateLight: 40, aiRateDeep: 15, aiDailyLimit: 500, aiMaxChars: 60000, aiMaxContracts: 400, windowMinutes: 15 },
      usage: { date: '2026-08-11', count: 3, dailyLimit: 500 },
      aiKeyConfigured: true, mode: 'api', version: 'stub123',
    }));
  });
  srv.listen(STUB_PORT, () => resolve(srv)).on('error', reject);
});

function startMapper() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), MAPPER_DATA: DATA, MAPPER_OWNER_EMAIL: OWNER,
      HATI_URL: `http://127.0.0.1:${STUB_PORT}`, MAPPER_TOKEN: HATI_SECRET, RESEND_API_KEY: '', ...source.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  child.getLog = () => log;
  return child;
}

async function waitUp(tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

let server = startMapper();
let browser = null;

try {
  if (!await waitUp()) throw new Error('the server never came up:\n' + server.getLog());

  console.log('\n2. Behind the login');
  const anon = await fetch(BASE + '/api/launch');
  check('The checklist needs a login', anon.status === 401, `HTTP ${anon.status}`);
  const anonWrite = await fetch(BASE + '/api/launch', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'code-on-disk', done: true }),
  });
  check('And so does ticking something off it', anonWrite.status === 401, `HTTP ${anonWrite.status}`);

  console.log('\n3. The page');
  browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  /* Same split verify.mjs makes, for the same reason: a failure to reach an
     external host — the Google Fonts stylesheet the design asks for — is a
     property of the network this runs on, not of the app. The page renders
     correctly without it. Errors raised by the page's own code, and failures
     to load anything from this origin, are the app's fault and must be zero. */
  const errors = [], external = [];
  const failedExternal = [];
  page.on('requestfailed', r => {
    if (!r.url().startsWith(BASE)) failedExternal.push(`${r.url()} — ${(r.failure() || {}).errorText || 'failed'}`);
  });
  page.on('pageerror', e => errors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const from = (m.location() && m.location().url) || '';
    if (from && !from.startsWith(BASE)) { external.push(`${from} — ${text}`); return; }
    if (/Failed to load resource/i.test(text) && failedExternal.length) { external.push(`${failedExternal.shift()} (${text})`); return; }
    errors.push(text);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth:not([hidden])', { timeout: 20000 });
  await page.fill('#authEmail', OWNER);
  await page.fill('#authPassword', PW);
  await page.fill('#authConfirm', PW);
  await page.click('#authGo');
  await page.waitForSelector('#towerBurn .bignum', { timeout: 180000 });

  await page.click('.pills button[data-p="launch"]');
  await page.waitForSelector('#launchNeedle .track', { timeout: 30000 });
  await page.waitForSelector('#launchList .lrow', { timeout: 30000 });

  const drawn = await page.evaluate(() => {
    const pin = document.querySelector('#launchNeedle .pin');
    const posts = [...document.querySelectorAll('#launchNeedle .post')];
    const track = document.querySelector('#launchNeedle .track');
    const pr = pin.getBoundingClientRect(), tr = track.getBoundingClientRect();
    return {
      verdict: document.querySelector('#launchNeedle .vd b').textContent.trim(),
      headline: document.querySelector('#launchNeedle .vd .sub').textContent.trim(),
      pinLabel: pin.querySelector('.lb').textContent.trim(),
      postLabels: posts.map(p => p.querySelector('.lb').textContent.trim()),
      postsHit: posts.filter(p => p.classList.contains('hit')).length,
      pinInsideTrack: pr.left >= tr.left - 2 && pr.right <= tr.right + 2,
      pinLabelOnCard: (() => {
        const l = pin.querySelector('.lb').getBoundingClientRect();
        const card = document.querySelector('#launchNeedle').closest('.card').getBoundingClientRect();
        return l.left >= card.left && l.right <= card.right;
      })(),
      boxes: document.querySelectorAll('#launchList .lbox').length,
      dots: document.querySelectorAll('#launchList .ldot').length,
      rows: document.querySelectorAll('#launchList .lrow').length,
      steps: document.querySelectorAll('#launchList .lsteps').length,
      ariaOnGauge: (document.querySelector('#launchNeedle .track').getAttribute('aria-label') || ''),
    };
  });

  check('The needle draws, with both posts labelled',
    drawn.postLabels.length === 2 && /demo/i.test(drawn.postLabels[0]) && /live/i.test(drawn.postLabels[1]),
    drawn.postLabels.join(' | '));
  check('It opens with a verdict in words, not only a number',
    /ready/i.test(drawn.verdict) && drawn.headline.length > 20,
    `${drawn.verdict} — ${drawn.headline}`);
  check('The pin stays on its track', drawn.pinInsideTrack);
  check('And its label stays on the card rather than off the side', drawn.pinLabelOnCard);
  check('A screen reader gets the whole gauge as one sentence',
    /needle is at \d+ out of 100/.test(drawn.ariaOnGauge), drawn.ariaOnGauge.slice(0, 90));
  check('The list draws, with tick boxes only where the owner has to answer',
    drawn.rows > 0 && drawn.boxes > 0 && drawn.rows === drawn.boxes + drawn.dots,
    `${drawn.rows} rows = ${drawn.boxes} boxes + ${drawn.dots} measured`);
  check('And the owner\'s items carry their steps',
    drawn.steps >= drawn.boxes, `${drawn.steps} step lists for ${drawn.boxes} boxes`);

  console.log('\n4. Ticking something off');
  const before = await page.evaluate(() => document.querySelector('#launchNeedle .pin .lb').textContent.trim());
  await page.click('#launchList .lbox');
  await page.waitForFunction(
    b => document.querySelector('#launchNeedle .pin .lb').textContent.trim() !== b,
    before, { timeout: 15000 });
  const after = await page.evaluate(() => ({
    needle: document.querySelector('#launchNeedle .pin .lb').textContent.trim(),
    lede: document.querySelector('#launchLede').textContent.trim(),
  }));
  check('Ticking an item moves the needle', after.needle !== before, `${before} → ${after.needle}`);

  /* The list defaults to what is left, so the row that was just ticked leaves
     the list. That is the behaviour, not a bug — check it explicitly rather
     than leaving it looking like the tick was lost. */
  const cookies = await ctx.cookies();
  const sess = cookies.filter(c => c.name === 'mapper_session')[0];
  const authed = p => fetch(BASE + p, { headers: { Cookie: `mapper_session=${sess.value}` } });
  const saved = await (await authed('/api/launch')).json();
  check('And the tick is on the server, not only on the screen',
    saved.items.some(i => i.how === 'you' && i.done),
    saved.items.filter(i => i.done).map(i => i.id).join(', '));

  /* Ticking on the default filter makes the row VANISH, which is correct and
     also exactly how a first, exploratory tick reads to somebody who has not
     met this list before: as though they deleted something and cannot get it
     back. It happened. So the tick has to say where the row went and offer the
     way back, and the way back has to actually work. */
  const undo = await page.evaluate(() => {
    const el = document.getElementById('toast');
    return el ? { text: el.textContent.trim(), hasButton: !!el.querySelector('button'), pressable: getComputedStyle(el).pointerEvents } : null;
  });
  check('Ticking says where the row went rather than letting it just disappear',
    !!undo && /has moved out of what’s left/.test(undo.text), undo ? undo.text : 'no toast');
  check('And offers the way back, which a click-through toast could not',
    !!undo && undo.hasButton && undo.pressable !== 'none', JSON.stringify(undo));

  await page.click('#toast button');
  await page.waitForFunction(t => document.querySelectorAll('#launchList .lrow').length > t,
    saved.counts.total - saved.counts.done, { timeout: 15000 });
  const undone = await (await authed('/api/launch')).json();
  check('Pressing Undo puts the item back, on the server and not only on screen',
    undone.counts.done === saved.counts.done - 1,
    `${undone.counts.done} done, was ${saved.counts.done}`);

  // Put it back so the checks below still describe a ticked item.
  await page.click('#launchList .lbox');
  await page.waitForFunction(() => !!document.querySelector('#toast button'), null, { timeout: 15000 });

  await page.click('#launchFilter button[data-f="all"]');
  const shownAll = await page.evaluate(() => document.querySelectorAll('#launchList .lrow').length);
  check('Switching to Everything shows the done items again',
    shownAll === saved.counts.total, `${shownAll} rows of ${saved.counts.total}`);
  const backVisible = await page.evaluate(() =>
    [...document.querySelectorAll('#launchList .lbox')].filter(b => b.getAttribute('aria-pressed') === 'true').length);
  check('And a ticked item is there with its box filled, not gone',
    backVisible >= 1, `${backVisible} ticked boxes on screen`);

  /* ---- the counters are the way into what they count ----
     "4 still to do before you show this to anyone" told the owner there were
     four and not WHICH four, and the four are scattered across six groups by
     design — the groups are about subject matter and the gates cut across
     them. A number with no way through to the things it counts is a wall. */
  console.log('\n4b. Getting from a number to the things it counts');
  const counters = await page.evaluate(() => [...document.querySelectorAll('#launchSums .sum')]
    .map(el => ({ n: el.querySelector('.n').textContent.trim(), lf: el.getAttribute('data-lf'), label: el.getAttribute('aria-label') })));
  check('A counter with something behind it offers a way in',
    counters.filter(c => c.lf).length >= 2 && counters.every(c => !c.lf || Number(c.n) > 0),
    counters.map(c => `${c.n}${c.lf ? '→' + c.lf : ''}`).join(' | '));
  check('And a counter reading nought does not, because there is nothing to show',
    counters.every(c => Number(c.n) !== 0 || !c.lf),
    counters.filter(c => Number(c.n) === 0).map(c => `${c.n}:${c.lf}`).join(', ') || 'no zero counters');
  check('The way in says what it will show, for a screen reader too',
    counters.filter(c => c.lf).every(c => /^Show the \d+ /.test(c.label || '')),
    (counters.find(c => c.lf) || {}).label);

  const demoCard = await page.$('#launchSums .sum[data-lf="demo"]');
  if (demoCard) {
    await demoCard.click();
    await page.waitForFunction(() => !!document.querySelector('#launchFocus .lfocus'), null, { timeout: 10000 });
    const focused = await page.evaluate(() => ({
      chip: document.querySelector('#launchFocus .lfocus').textContent.trim(),
      rows: [...document.querySelectorAll('#launchList .lrow')].length,
      gates: [...document.querySelectorAll('#launchList .lgate')].map(g => g.textContent.trim()),
    }));
    check('Clicking the demo counter narrows the list to exactly what it counted',
      focused.rows === saved.counts.demoOpen,
      `${focused.rows} rows for a counter reading ${saved.counts.demoOpen}`);
    check('And every one of them is one that blocks a demo',
      focused.gates.length > 0 && focused.gates.every(g => /blocks the demo/.test(g)),
      focused.gates.join(' | '));
    check('The list says what it is holding back rather than quietly showing a subset',
      /Showing the \d+ blocking a demo/.test(focused.chip), focused.chip);

    await page.click('#launchFocus button[data-clear]');
    await page.waitForFunction(() => !document.querySelector('#launchFocus .lfocus'), null, { timeout: 10000 });
    const cleared = await page.evaluate(() => document.querySelectorAll('#launchList .lrow').length);
    check('And there is a way back out of it',
      cleared === saved.counts.total - saved.counts.done,
      `${cleared} rows back`);
  } else {
    check('Clicking the demo counter narrows the list to exactly what it counted', false,
      'no demo counter was drawn — nothing was blocking a demo');
  }

  /* ---- putting something right from the row that explains it ---- */
  console.log('\n4c. Fixing something from the row itself');
  await page.click('#launchFilter button[data-f="all"]');
  const actionable = await page.evaluate(() => {
    const b = document.querySelector('#launchList button[data-act-id]');
    return b ? { id: b.getAttribute('data-act-id'), label: b.textContent.trim() } : null;
  });
  check('Something the Mapper measures AND owns can be put right from its own row',
    !!actionable && actionable.id === 'spend-tripwire' && /Arm it at \d+ a day/.test(actionable.label),
    actionable ? `${actionable.id}: ${actionable.label}` : 'no action button drawn');

  if (actionable) {
    await page.click('#launchList button[data-act-id]');
    await page.waitForFunction(() => !document.querySelector('#launchList button[data-act-id]'), null, { timeout: 20000 });
    const armed = await (await authed('/api/watch')).json();
    const rule = (armed.rules || []).filter(r => r.name === 'aiRequests')[0];
    check('Pressing it arms the real rule, through the same route Settings uses',
      !!rule && rule.on === true, JSON.stringify(rule));
    const afterArm = await (await authed('/api/launch')).json();
    const trip = afterArm.items.find(i => i.id === 'spend-tripwire');
    check('And the item settles from a fresh measurement, not from the button assuming it worked',
      trip.done === true && /Armed at \d+ AI requests a day/.test(trip.detail || ''),
      `${trip.state}: ${trip.detail}`);
    check('It is still not a tick box — the Mapper measured this, it was not claimed',
      !(await page.$('#launchList .lrow .lbox[data-tick="spend-tripwire"]')),
      'no tick box for a measured item');
  }

  console.log('\n5. What it refuses');
  const bogus = await fetch(BASE + '/api/launch', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `mapper_session=${sess.value}` },
    body: JSON.stringify({ id: 'not-a-real-item', done: true }),
  });
  check('An item that does not exist is refused rather than stored',
    bogus.status === 400, `HTTP ${bogus.status}`);

  const measured = ITEMS.find(i => i.how === 'mapper').id;
  const overrule = await fetch(BASE + '/api/launch', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `mapper_session=${sess.value}` },
    body: JSON.stringify({ id: measured, done: true }),
  });
  check('And an item the Mapper measures cannot be ticked off by hand',
    overrule.status === 400, `${measured} → HTTP ${overrule.status}`);

  /* The date is what staleness is measured against, so a browser that could
     choose it could keep a two-year-old backup counting forever. */
  const forged = await fetch(BASE + '/api/launch', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `mapper_session=${sess.value}` },
    body: JSON.stringify({ id: 'data-on-disk', done: true, at: ago(-3650) }),
  });
  const forgedBody = await forged.json();
  const dataItem = forgedBody.items.find(i => i.id === 'data-on-disk');
  check('A tick is dated by the server, so a date sent from the browser is ignored',
    dataItem.done && /Ticked today/.test(dataItem.detail || ''), dataItem.detail);

  /* Taken before the restart below, which kills the server out from under a
     page that is still open — the browser logs a connection reset for that,
     and it is the test's own doing rather than anything the checklist drew. */
  check('Drawing the checklist raises no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  if (external.length) console.log(`        (${external.length} external asset(s) unreachable on this network, not counted: ${external[0]})`);

  console.log('\n6. It survives a restart');
  const wasDone = saved.items.filter(i => i.how === 'you' && i.done).length;
  server.kill();
  await new Promise(r => setTimeout(r, 500));
  server = startMapper();
  if (!await waitUp()) throw new Error('the server did not come back up');
  const again = await (await authed('/api/launch')).json();
  check('Ticks written to disk are still there after a restart',
    again.items.filter(i => i.how === 'you' && i.done).length >= wasDone,
    `${again.items.filter(i => i.how === 'you' && i.done).length} ticked, was ${wasDone}`);
  check('And the page says so, rather than assuming it',
    again.durable === true, `durable=${again.durable}`);

  await page.close();
} catch (e) {
  check('The launch-checklist test itself completed', false, e.stack || String(e));
  console.error(server.getLog().slice(-2000));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  if (stubHati) stubHati.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
