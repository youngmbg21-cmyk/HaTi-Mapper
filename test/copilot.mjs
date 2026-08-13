/* HaTi-Mapper — the Copilot panel.
 *
 * Everything here is a bug that has already happened in a product built this
 * way, pinned so it cannot happen again:
 *
 *   - the register is read at CALL time, not frozen when a module loads
 *   - flipping the toggle restates the answer already on screen, IN PLACE
 *   - both versions are cached, so flipping back never asks the model again
 *   - EVERY path that sends a prompt carries the register
 *   - the model cannot inject markup through a reply
 *   - an unknown chart kind shows a card, not a broken panel
 *   - the model never supplies a chart's numbers
 *
 * It drives the real front end in a real browser against a real server, with
 * a stand-in playing the model's part so the loop can be scripted exactly.
 *
 *   node test/copilot.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';
import { CHART_KINDS } from '../lib/chat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.COPILOT_PORT || 4510);
const STUB = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-copilot-data');
const SHOTS = path.join(ROOT, '.tmp-copilot-shots');

const OWNER_EMAIL = 'copilot@example.com';
const OWNER_PW = 'copilotpass1';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

/* ------------------------------------------------- the stand-in model ---- */

let seen = [];        // every request body the stub received
let script = [];      // queued replies

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    seen.push(JSON.parse(raw));
    const next = script.shift();
    if (!next) { res.writeHead(500).end('{}'); return; }
    /* A scripted reply is normally just its content blocks. An entry shaped
       { content, stop_reason } sets the stop reason as well, which is the only
       way to exercise the turns that come back a perfectly ordinary HTTP 200
       with an answer-shaped hole in them. */
    const body = Array.isArray(next) ? { content: next } : next;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_t', type: 'message', role: 'assistant',
      content: body.content || [], stop_reason: body.stop_reason, usage: {},
    }));
  });
});

const deliver = (answer, extra) => [{
  type: 'tool_use', id: 'tu_deliver', name: 'deliver_answer',
  input: { answer, ...(extra || {}) },
}];

/* A turn the model did not finish. `content` is whatever it managed before it
   stopped — which the panel must never show as though it were the answer. */
const stoppedBy = (reason, content) => ({ stop_reason: reason, content: content || [] });

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

/* ---------------------------------------------------------------- run ---- */

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const source = await hatiSource();
announce(source);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    MAPPER_DATA: DATA,
    ANTHROPIC_API_KEY: 'sk-ant-' + 'NOT-A-REAL-KEY-stand-in',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`,
    HATI_URL: '',
    MAPPER_TOKEN: '',
    ...source.env,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

let browser = null;
const appErrors = [];

try {
  await new Promise((resolve, reject) => stub.listen(STUB, resolve).on('error', reject));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\nHaTi-Mapper — the Copilot panel\n');

  browser = await chromium.launch({ executablePath: chromiumPath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  /* A failed request is not an app error: several checks below deliberately
     make the assistant fail, and the app's job is to say so in the panel
     rather than to prevent the browser logging it. What must be zero is
     errors raised by the page's own code. Anything filtered is printed, so
     nothing hides behind the distinction. */
  const networkNoise = [];
  page.on('pageerror', e => appErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|net::ERR_/.test(t)) networkNoise.push(t);
    else appErrors.push(t);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth:not([hidden])', { timeout: 20000 });
  await page.fill('#authEmail', OWNER_EMAIL);
  await page.fill('#authPassword', OWNER_PW);
  await page.fill('#authConfirm', OWNER_PW);
  await page.click('#authGo');
  await page.waitForSelector('#towerBurn .bignum', { timeout: 180000 });

  await page.click('#askLaunch');
  await page.waitForSelector('#ask:not([hidden])');

  /* ---- 1. the toggle is there, and Plain is the default ---- */
  console.log('The toggle');
  check('The toggle sits in the panel, above the input box',
    await page.isVisible('#askRegister button[data-reg="plain"]') &&
    await page.isVisible('#askRegister button[data-reg="technical"]'));
  check('It is labelled ANSWERS · Plain · Technical',
    /answers/i.test(await page.textContent('.regrow')) &&
    /Plain/.test(await page.textContent('#askRegister')) &&
    /Technical/.test(await page.textContent('#askRegister')));
  check('Plain is the default',
    await page.getAttribute('#askRegister button[data-reg="plain"]', 'aria-pressed') === 'true');
  const foot = await page.evaluate(() => {
    const r = document.querySelector('.regrow').getBoundingClientRect();
    const i = document.querySelector('#askInput').getBoundingClientRect();
    return { regBottom: r.bottom, inputTop: i.top };
  });
  check('It is ABOVE the input box, not below it', foot.regBottom <= foot.inputTop + 1,
    `toggle bottom ${Math.round(foot.regBottom)}, input top ${Math.round(foot.inputTop)}`);
  await page.screenshot({ path: path.join(SHOTS, '1-toggle.png') });

  /* ---- 2. asking carries the register, in plain by default ---- */
  console.log('\nEvery prompt path carries the register');
  seen = [];
  script = [deliver(
    'The **login page** is fine. Nothing has gone down today.\n\n' +
    '- {+all green for 14 days}\n' +
    '- {~this check runs every 5 minutes}\n',
    { sources: [{ panel: 'changes' }] },
  )];
  await page.fill('#askInput', 'Is anything broken right now?');
  await page.click('#askSend');
  await page.waitForSelector('#askFeed .msg.bot .mk-good', { timeout: 30000 });

  check('The main chat sends a system prompt in the plain register',
    /REGISTER: PLAIN/.test(seen[0].system || '') && !/REGISTER: TECHNICAL/.test(seen[0].system || ''));
  check('The ground rules ride along in both registers',
    /GROUND RULES — BOTH REGISTERS/.test(seen[0].system || '') &&
    /I can't see that from here/.test(seen[0].system || ''));
  check('And the chart contract',
    /YOU NAME ONE, YOU NEVER SUPPLY ITS NUMBERS/.test(seen[0].system || ''));
  check('The tool that delivers the answer carries the register too, not a frozen "short and plain"',
    /short, plain markdown/.test(
      (seen[0].tools || []).filter(t => t.name === 'deliver_answer')[0]?.input_schema?.properties?.answer?.description || ''));
  check('Colour markers render as coloured spans',
    (await page.textContent('#askFeed .mk-good')).indexOf('all green for 14 days') >= 0);
  check('And the aside marker as its own kind', await page.isVisible('#askFeed .mk-aside'));
  await page.screenshot({ path: path.join(SHOTS, '2-plain-answer.png') });

  /* ---- 3. flipping restates the answer already on screen, in place ---- */
  console.log('\nFlipping the toggle');
  const bubblesBefore = await page.locator('#askFeed .msg.bot').count();
  seen = [];
  script = [deliver(
    'No incidents in the observed window. `GET /api/health` returned 200 on every scan; ' +
    'the watch log records 0 events in the last 72h.',
  )];
  await page.click('#askRegister button[data-reg="technical"]');
  await page.waitForFunction(
    () => /GET \/api\/health/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });

  check('Flipping asks the model again, in the register just chosen',
    seen.length === 1 && /REGISTER: TECHNICAL/.test(seen[0].system || ''));
  check('And tells it that it is restating, not answering afresh',
    /YOU ARE RESTATING AN ANSWER YOU ALREADY GAVE/.test(seen[0].system || ''));
  check('And that nothing may be lost in either direction',
    /Nothing may be lost going into the plainer register/.test(seen[0].system || ''));
  const bubblesAfter = await page.locator('#askFeed .msg.bot').count();
  check('The existing bubble is REPLACED, not joined by a second one',
    bubblesAfter === bubblesBefore, `${bubblesBefore} bubbles before, ${bubblesAfter} after`);
  check('The old wording is gone from the screen',
    !/all green for 14 days/.test(await page.textContent('#askFeed')));
  await page.screenshot({ path: path.join(SHOTS, '3-technical-restated.png') });

  /* ---- 4. both versions are cached ---- */
  seen = [];
  script = [];      // any request at all would now fail, which is the point
  await page.click('#askRegister button[data-reg="plain"]');
  await page.waitForFunction(
    () => /all green for 14 days/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 15000 });
  check('Flipping back is instant and never re-asks the model', seen.length === 0, `${seen.length} calls`);
  check('The plain wording came back exactly as it was',
    /all green for 14 days/.test(await page.textContent('#askFeed')));

  seen = [];
  await page.click('#askRegister button[data-reg="technical"]');
  await page.waitForFunction(
    () => /GET \/api\/health/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 15000 });
  check('And so is flipping forward again', seen.length === 0, `${seen.length} calls`);

  /* ---- 5. the register is READ AT CALL TIME, not frozen at load ---- */
  console.log('\nThe register is read at call time');
  seen = [];
  script = [deliver('p95 on POST /auth/login is 180ms; unchanged since 02:00 UTC.')];
  await page.fill('#askInput', 'And the login page?');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /p95 on POST/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });
  check('A question asked AFTER the flip goes out in the flipped register',
    /REGISTER: TECHNICAL/.test(seen[0].system || '') && !/REGISTER: PLAIN\b/.test(seen[0].system || ''));
  check('And its deliver_answer description flipped with it',
    /full engineering depth/.test(
      (seen[0].tools || []).filter(t => t.name === 'deliver_answer')[0]?.input_schema?.properties?.answer?.description || ''));

  /* The same assertion where it actually bites: the module, called twice. */
  const modChecks = await (async () => {
    const m = await import('../lib/chat.mjs');
    const a = m.buildSystem({ scan: {}, historyStatus: {}, pulse: {}, register: 'plain' });
    const b = m.buildSystem({ scan: {}, historyStatus: {}, pulse: {}, register: 'technical' });
    const c = m.buildSystem({ scan: {}, historyStatus: {}, pulse: {}, register: 'plain' });
    return {
      differ: /REGISTER: PLAIN/.test(a) && /REGISTER: TECHNICAL/.test(b) && /REGISTER: PLAIN/.test(c),
      toolsDiffer: JSON.stringify(m.chatTools('plain')) !== JSON.stringify(m.chatTools('technical')),
      isFn: typeof m.registerRules === 'function' && typeof m.chatTools === 'function',
    };
  })();
  check('buildSystem is a function of the register, not a constant', modChecks.differ);
  check('So is the tool list', modChecks.toolsDiffer);
  check('Both are functions, evaluated per call', modChecks.isFn);

  /* ---- 6. the draft path carries it too ---- */
  console.log('\nThe "draft a fix prompt" path');
  const scanned = await (await fetch(`${BASE}/api/scan`, {
    headers: { Cookie: `mapper_session=${(await ctx.cookies()).filter(c => c.name === 'mapper_session')[0].value}` },
  })).json();
  const orphan = (scanned.weight?.orphans || [])[0];
  seen = [];
  script = [deliver('A drafted prompt.')];
  await page.evaluate((name) => {
    return fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ register: 'technical', draft: { kind: 'orphan', id: name } }),
    }).then(r => r.json());
  }, orphan.name);
  check('Drafting a fix prompt carries the register into the system prompt',
    /REGISTER: TECHNICAL/.test(seen[0]?.system || ''));
  check('And into the fixed list of things the drafted prompt must do',
    /Write the whole prompt for the session/.test(seen[0]?.system || ''),
    (seen[0]?.system || '').slice(-200));

  seen = [];
  script = [deliver('A drafted prompt.')];
  await page.evaluate((name) => {
    return fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ register: 'plain', draft: { kind: 'orphan', id: name } }),
    }).then(r => r.json());
  }, orphan.name);
  const draftMsg = String(seen[0]?.messages?.[0]?.content || '');
  check('In plain, the drafted prompt is told to open in ordinary English',
    /open with one sentence, in ordinary English/.test(draftMsg), draftMsg.slice(0, 120));
  check('And the file paths in it stay exact either way',
    draftMsg.includes(orphan.exportedFrom) && draftMsg.includes(orphan.name));

  /* ---- 6b. one funnel, so a fourth path cannot forget ----

     The strongest version of "every prompt path carries the register" is not
     a list that has to be re-checked by hand, but a shape: the model is
     reached from ONE place on the server, and that place is reached from ONE
     place in the browser, which sets the register unconditionally. */
  console.log('\nOne funnel');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const callsToModel = (serverSrc.match(/await anthropicMessages\(/g) || []).length;
  check('The server reaches the model from exactly one place',
    callsToModel === 1, `${callsToModel} call sites`);
  const buildSystemCalls = (serverSrc.match(/buildSystem\(/g) || []).length;
  check('And builds its system prompt in exactly one place',
    buildSystemCalls === 1, `${buildSystemCalls} call sites`);
  check('That one place passes the register into both the prompt and the tools',
    /buildSystem\(\{[\s\S]{0,400}?register,/.test(serverSrc) && /chatTools\(register\)/.test(serverSrc));
  const chatFetches = (appSrc.match(/'\/api\/chat'/g) || []).length;
  check('The browser posts to the assistant from exactly one place',
    chatFetches === 1, `${chatFetches} call sites`);
  check('And that place always attaches the register, read at call time',
    /send\('POST', '\/api\/chat', Object\.assign\(\{ register: currentRegister\(\) \}/.test(appSrc));
  check('Nothing captures the register into a module-level constant',
    !/^\s*var\s+\w*[Rr]egister\w*\s*=\s*currentRegister\(\)/m.test(appSrc));

  /* ---- 7. the choice sticks ---- */
  console.log('\nThe choice sticks');
  await page.click('#askRegister button[data-reg="plain"]');
  await page.waitForTimeout(400);
  const savedOnServer = await (await fetch(`${BASE}/api/preferences`, {
    headers: { Cookie: `mapper_session=${(await ctx.cookies()).filter(c => c.name === 'mapper_session')[0].value}` },
  })).json();
  check('The choice is saved on the server', savedOnServer.answerRegister === 'plain', JSON.stringify(savedOnServer));
  await page.click('#askRegister button[data-reg="technical"]');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#towerBurn .bignum', { timeout: 180000 });
  await page.click('#askLaunch');
  check('And survives a reload in the browser',
    await page.getAttribute('#askRegister button[data-reg="technical"]', 'aria-pressed') === 'true');
  /* A browser that has never been told adopts what the server remembers. */
  const fresh = await ctx.newPage();
  await fresh.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  await fresh.goto(BASE, { waitUntil: 'domcontentloaded' });
  await fresh.waitForSelector('#towerBurn .bignum', { timeout: 180000 });
  await fresh.click('#askLaunch');
  await fresh.waitForTimeout(600);
  check('A browser that has never been told adopts the saved choice',
    await fresh.getAttribute('#askRegister button[data-reg="technical"]', 'aria-pressed') === 'true');
  await fresh.close();

  /* ---- 8. the model cannot inject markup ---- */
  console.log('\nThe reply is untrusted input');
  await page.click('#askClear');
  seen = [];
  script = [deliver([
    '<img src=x onerror="window.__pwned=1">',
    '',
    '<script>window.__pwned = 2;<' + '/script>',
    '',
    'A log line from the monitored system: `<b onclick="alert(1)">"quoted" & \'apostrophed\'</b>`',
    '',
    '[click me](javascript:window.__pwned=3)',
    '',
    '[also me](data:text/html,<script>window.__pwned=4<' + '/script>)',
    '',
    '[protocol relative](//evil.example.com/x)',
    '',
    '[a real one](https://example.com/ok)',
  ].join('\n'))];
  await page.fill('#askInput', 'show me the log line');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /onerror/.test(document.querySelector('#askFeed').textContent), null, { timeout: 30000 });

  const inject = await page.evaluate(() => {
    const body = document.querySelector('#askFeed .msg.bot .body');
    /* Real attributes on real elements — not a search of the serialized
       string, where the escaped TEXT " onerror=" reads like an attribute and
       is nothing of the kind. */
    const handlers = [];
    body.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (/^on/i.test(a.name)) handlers.push(el.tagName.toLowerCase() + '[' + a.name + ']');
      });
    });
    return {
      pwned: window.__pwned || null,
      imgs: body.querySelectorAll('img').length,
      scripts: body.querySelectorAll('script').length,
      hrefs: Array.from(body.querySelectorAll('a')).map(a => a.getAttribute('href')),
      tags: Array.from(new Set(Array.from(body.querySelectorAll('*')).map(e => e.tagName.toLowerCase()))),
      handlers: handlers,
      text: body.textContent,
    };
  });
  check('Nothing the model wrote executed', inject.pwned === null, String(inject.pwned));
  check('No element the model named was created',
    inject.imgs === 0 && inject.scripts === 0, `${inject.imgs} img, ${inject.scripts} script`);
  check('The markup is shown as the text it is', /onerror=/.test(inject.text));
  check('No handler attribute survived anywhere in the answer',
    inject.handlers.length === 0, inject.handlers.join(', '));
  check('Only the renderer\'s own elements exist in the bubble',
    inject.tags.every(t => ['p', 'ul', 'ol', 'li', 'code', 'pre', 'strong', 'em', 'a', 'h3', 'h4', 'h5', 'h6',
      'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'figure', 'figcaption', 'canvas'].indexOf(t) >= 0),
    inject.tags.join(','));
  check('javascript: is not clickable', !inject.hrefs.some(h => /^javascript:/i.test(h || '')));
  check('data: is not clickable', !inject.hrefs.some(h => /^data:/i.test(h || '')));
  check('A protocol-relative //host is not clickable', !inject.hrefs.some(h => /^\/\//.test(h || '')));
  check('A refused address still reads as the text it is',
    /javascript:window.__pwned=3/.test(inject.text));
  check('An allowed https address is still a link',
    inject.hrefs.some(h => h === 'https://example.com/ok'), JSON.stringify(inject.hrefs));
  await page.screenshot({ path: path.join(SHOTS, '4-inert.png') });

  /* The escaping that matters most is the one nobody sees: a chunk of the
     model's reply landing INSIDE an attribute value. The drafted-prompt bubble
     carries the whole answer in a data- attribute so it can be copied, which
     makes it the honest place to test that quotes and apostrophes are escaped
     rather than ending the attribute early. */
  const ATTR_BREAKOUT = 'Run: echo "it\'s fine" && exit" onclick="window.__pwned=9" data-x="';
  await page.click('#askClear');
  seen = [];
  script = [deliver(ATTR_BREAKOUT)];
  /* Pressed rather than faked: the page's own "Draft a fix prompt" handler is
     what renders the copy button, so that is the path under test. */
  await page.evaluate((name) => {
    const b = document.createElement('button');
    b.setAttribute('data-fix', 'orphan');
    b.setAttribute('data-id', name);
    b.style.display = 'none';
    document.body.appendChild(b);
    b.click();
    b.remove();
  }, orphan.name);
  await page.waitForSelector('#askFeed button.copy', { timeout: 30000 });
  const attr = await page.evaluate(() => {
    const b = document.querySelector('#askFeed button.copy');
    return {
      copy: b.getAttribute('data-copy'),
      names: Array.from(b.attributes).map(a => a.name),
      pwned: window.__pwned || null,
    };
  });
  check('A reply that tries to break out of an attribute cannot',
    attr.names.indexOf('onclick') < 0 && attr.names.indexOf('data-x') < 0 && attr.pwned === null,
    attr.names.join(','));
  check('And the text it carries survives intact, quotes and apostrophes and all',
    attr.copy === ATTR_BREAKOUT, JSON.stringify(attr.copy || '').slice(0, 140));

  /* A drafted prompt is an artefact to paste, not an explanation. Flipping the
     toggle over one must not rewrite it. */
  seen = [];
  script = [];
  await page.click('#askRegister button[data-reg="technical"]');
  await page.waitForTimeout(600);
  check('Flipping the toggle never rewrites a drafted prompt',
    seen.length === 0 && (await page.getAttribute('#askFeed button.copy', 'data-copy')) === ATTR_BREAKOUT,
    `${seen.length} calls`);
  await page.click('#askRegister button[data-reg="plain"]');
  await page.waitForTimeout(300);

  /* ---- 9. charts ---- */
  console.log('\nCharts');
  check('The chart library is NOT in the page head',
    !/charts\.js/.test(await page.content()) || (await page.locator('head script[src*="charts.js"]').count()) === 0);

  await page.click('#askClear');
  seen = [];
  script = [deliver(
    'Costs have been flat. The chart below is the same series the burn tile draws.\n\n' +
    '```monitor-chart\n{ "kind": "cost-trend", "title": "A day at the caps" }\n```\n',
  )];
  await page.fill('#askInput', 'what is this costing me');
  await page.click('#askSend');
  await page.waitForSelector('#askFeed .chartcard', { timeout: 30000 });
  check('A named chart kind becomes a chart card', await page.isVisible('#askFeed .chartcard'));
  check('The card says where the numbers came from, not that the model supplied them',
    /Drawn by this page from/.test(await page.textContent('#askFeed .chartcard')) ||
    /fewer than three readings/.test(await page.textContent('#askFeed .chartcard')),
    (await page.textContent('#askFeed .chartcard')).slice(0, 140));
  check('The chart block itself never reaches the reader',
    !/monitor-chart/.test(await page.textContent('#askFeed')));
  await page.screenshot({ path: path.join(SHOTS, '5-chart.png') });

  /* An unknown kind: a visible card, not a broken panel. */
  seen = [];
  script = [deliver('Here you go.\n\n```monitor-chart\n{ "kind": "flux-capacitance" }\n```\n')];
  await page.fill('#askInput', 'draw me something impossible');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /Unknown chart/.test(document.querySelector('#askFeed').textContent), null, { timeout: 30000 });
  check('An unknown chart kind shows a card naming it',
    /flux-capacitance/.test(await page.textContent('#askFeed')));
  check('And the rest of the answer still renders',
    /Here you go/.test(await page.textContent('#askFeed')));
  check('And the panel is still alive', await page.isVisible('#askInput'));

  /* A malformed block. */
  seen = [];
  script = [deliver('Try this.\n\n```monitor-chart\nnot json at all\n```\n')];
  await page.fill('#askInput', 'break it');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /could not be read/.test(document.querySelector('#askFeed').textContent), null, { timeout: 30000 });
  check('A chart block that is not readable shows a card, not a blank box',
    /could not be read/.test(await page.textContent('#askFeed')));

  /* The model's own numbers are allowed only through "quoted", and are
     labelled as its numbers. */
  seen = [];
  script = [deliver(
    'I counted 3, 5 and 2 over the last three days.\n\n' +
    '```monitor-chart\n' + JSON.stringify({
      kind: 'quoted', title: 'What I counted', unit: 'changes',
      points: [{ label: 'Mon', value: 3 }, { label: 'Tue', value: 5 }, { label: 'Wed', value: 2 }],
    }) + '\n```\n')];
  await page.fill('#askInput', 'quote me some numbers');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /own figures/.test(document.querySelector('#askFeed').textContent), null, { timeout: 30000 });
  check('The one kind that takes the model\'s own numbers says so on screen',
    /The assistant’s own figures/.test(await page.textContent('#askFeed')));
  check('And says they are not measured by this dashboard',
    /not measured by this dashboard/.test(await page.textContent('#askFeed')));
  await page.screenshot({ path: path.join(SHOTS, '6-quoted.png') });

  /* Two charts in one reply: the first is drawn, the rest say why not. */
  seen = [];
  script = [deliver(
    'Both of these matter.\n\n```monitor-chart\n{ "kind": "biggest-files" }\n```\n\n' +
    '```monitor-chart\n{ "kind": "gaps-trend" }\n```\n')];
  await page.fill('#askInput', 'draw me two');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /Only the first chart is drawn/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });
  check('A second chart in one reply is refused visibly, not drawn',
    /Only the first chart is drawn/.test(await page.textContent('#askFeed')));

  /* A canvas holds pixels, not styles, so it does not follow the theme on its
     own the way everything else on the page does. */
  const beforeTheme = await page.evaluate(() => {
    const c = document.querySelector('#askFeed canvas');
    return c ? c.toDataURL().length : 0;
  });
  await page.click('#themeBtn');
  await page.waitForTimeout(500);
  const afterTheme = await page.evaluate(() => {
    const c = document.querySelector('#askFeed canvas');
    return c ? c.toDataURL().length : 0;
  });
  check('A chart redraws when the theme is switched', beforeTheme > 0 && afterTheme !== beforeTheme,
    `${beforeTheme} → ${afterTheme}`);
  await page.screenshot({ path: path.join(SHOTS, '6b-light.png') });
  await page.click('#themeBtn');
  await page.waitForTimeout(300);

  /* The registry, and clearing the conversation. */
  const liveBefore = await page.evaluate(() => document.querySelectorAll('#askFeed canvas').length);
  check('Charts are on screen before clearing', liveBefore > 0, `${liveBefore} canvases`);
  await page.click('#askClear');
  await page.waitForTimeout(300);
  const liveAfter = await page.evaluate(() => document.querySelectorAll('#askFeed canvas').length);
  check('Clearing the conversation takes the charts with it', liveAfter === 0, `${liveAfter} canvases`);

  /* The kinds the model is told about are the kinds the page can draw. */
  const clientKinds = await page.evaluate(() => {
    /* Pulled out of the page rather than the file, so this compares what the
       browser actually has against what the server actually says. */
    return window.__mapperChartKinds || null;
  });
  const serverKinds = CHART_KINDS.map(c => c.kind).filter(k => k !== 'quoted').sort();
  check('The kinds the model is offered are the kinds the page can draw',
    clientKinds ? JSON.stringify(clientKinds.slice().sort()) === JSON.stringify(serverKinds) : false,
    `server: ${serverKinds.join(',')}\n        client: ${(clientKinds || []).join(',')}`);

  /* ---- 9b. the turn that came back with no answer in it ----

     Both of these arrive as an ordinary HTTP 200. Nothing in the transport
     notices, and everything downstream will happily treat the hole where the
     answer should be as an answer. The plain-register ceiling used to be 1600
     tokens, which on this model covers the model's own thinking as well as its
     words — so a wide question spent it thinking, the turn ended on max_tokens,
     and the owner was told "I could not finish working that one out", which
     reads as confusion rather than as a ceiling. */
  console.log('\nA turn that stopped before it answered');

  seen = [];
  script = [deliver('Room to answer.')];
  await page.fill('#askInput', 'how much room do you have');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /Room to answer/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });
  check('The ceiling covers thinking as well as words, so it is generous',
    seen[0].max_tokens === 8000, `max_tokens ${seen[0].max_tokens}`);
  check('Effort is set deliberately rather than left to default',
    seen[0].output_config?.effort === 'medium', JSON.stringify(seen[0].output_config));
  check('None of the parameters this model rejects are sent',
    seen[0].temperature === undefined && seen[0].top_p === undefined &&
    seen[0].top_k === undefined && seen[0].budget_tokens === undefined);

  /* Cut off mid-answer. */
  seen = [];
  script = [stoppedBy('max_tokens', [{ type: 'text', text: 'The three things you should look at are the fir' }])];
  await page.fill('#askInput', 'explain absolutely everything');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /ran long and got cut off/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });
  check('A turn that hit the ceiling says so, in words about room rather than confusion',
    /ran long and got cut off/.test(await page.textContent('#askFeed')));
  check('It does not say it could not work the question out',
    !/could not finish working that one out/.test(await page.textContent('#askFeed')));
  check('And the half-written sentence is not shown as the answer',
    !/three things you should look at/.test(await page.textContent('#askFeed')));

  /* Declined. */
  seen = [];
  script = [stoppedBy('refusal', [{ type: 'text', text: 'Here is how you would exploit' }])];
  await page.fill('#askInput', 'something it will not answer');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /could not answer that one/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });
  check('A declined turn says so plainly', /could not answer that one/.test(await page.textContent('#askFeed')));
  check('And none of the partial content reaches the screen',
    !/how you would exploit/.test(await page.textContent('#askFeed')));

  /* The rule that outlives both: an error is never fed back to the model as
     something it said. Two of them in a row, then a real question. */
  seen = [];
  script = [deliver('Back to normal.')];
  await page.fill('#askInput', 'and now a normal question');
  await page.click('#askSend');
  await page.waitForFunction(
    () => /Back to normal/.test(document.querySelector('#askFeed').textContent),
    null, { timeout: 30000 });
  const sentBack = JSON.stringify(seen[0].messages || []);
  check('Neither error is sent back to the model as a turn it took',
    !/ran long and got cut off/.test(sentBack) && !/could not answer that one/.test(sentBack));
  check('But the questions that produced them are still there',
    /explain absolutely everything/.test(sentBack));
  await page.screenshot({ path: path.join(SHOTS, '8-stopped-early.png') });

  await page.click('#askClear');
  await page.waitForTimeout(200);

  /* ---- 10. it is all in the one panel, so it reaches a phone too ---- */
  console.log('\nOn a narrow screen');
  /* The same signed-in context at phone width, because this app has ONE
     layout and one panel rather than a separate mobile screen — which is the
     property being checked. */
  const pp = await ctx.newPage();
  await pp.setViewportSize({ width: 390, height: 780 });
  await pp.goto(BASE, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('#towerBurn .bignum', { timeout: 180000 });
  await pp.click('#askLaunch');
  await pp.waitForSelector('#ask:not([hidden])');
  check('The toggle is on the panel at phone width too',
    await pp.isVisible('#askRegister button[data-reg="technical"]'));
  const fits = await pp.evaluate(() => {
    const p = document.querySelector('#ask').getBoundingClientRect();
    return p.right <= window.innerWidth + 1 && p.left >= -1;
  });
  check('And the panel still fits the screen', fits);
  seen = [];
  script = [deliver('Small screen, same answer.\n\n```monitor-chart\n{ "kind": "changes-by-area" }\n```\n')];
  await pp.fill('#askInput', 'anything broken');
  await pp.click('#askSend');
  await pp.waitForSelector('#askFeed .chartcard', { timeout: 30000 });
  check('And a chart draws there as well, from the same shared renderer',
    await pp.isVisible('#askFeed .chartcard'));
  const noOverflow = await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('Nothing in the panel pushes the page sideways', noOverflow);
  await pp.screenshot({ path: path.join(SHOTS, '7-phone.png') });
  await pp.close();

  check('The page logged no errors of its own', appErrors.length === 0, appErrors.slice(0, 3).join('\n        '));
  if (networkNoise.length) {
    console.log(`  note  ${networkNoise.length} failed request(s) logged by the browser, from the checks that ` +
      'deliberately make the assistant fail:\n        ' + networkNoise.slice(0, 3).join('\n        '));
  }
} catch (e) {
  check('The Copilot test itself completed', false, e.stack || String(e));
  console.error(log.slice(-3000));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  stub.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\nScreenshots in ${path.relative(ROOT, SHOTS)}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
