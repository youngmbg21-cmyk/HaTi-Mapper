/* HaTi-Mapper — the assistant and the tabs must never disagree.
 *
 * The control tower already has this promise made about it, in the README and
 * in the verification suite: it is a summary, never a second source, and every
 * figure on it is read from the same scan the panels below are drawn from.
 *
 * The assistant is the one reader of this data that was NOT pinned that way.
 * It is also the reader most likely to be believed, because it answers in
 * sentences rather than in cards. An assistant that quietly disagrees with the
 * tab beside it is worse than no assistant at all, and until this file existed
 * nothing would have noticed.
 *
 * Most of runTool() reads the same cached scan the tabs render, so most of it
 * is safe by construction. This tests the places where the two reach the same
 * fact by DIFFERENT ROUTES, because those are the only places drift can start:
 *
 *   - the launch checklist is evaluated inside /api/chat AND inside /api/launch
 *   - the change log is read through get_changes AND through /api/changes
 *   - the live caps are read through get_live_usage AND through /api/pulse
 *   - "files over the line" is COUNTED from the file list on one side and read
 *     from a precomputed total on the other
 *   - the money headline is interpolated into the briefing by hand
 *
 * Nothing here is mocked. It boots the real server, signs in like a browser,
 * and drives the real /api/chat with a stand-in model that calls every tool —
 * so what is compared is what the assistant would actually have been handed,
 * through the whole real path, not what a unit test thinks it would be.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IF YOU ADD A FIELD TO runTool(), ADD A ROW HERE.
 * A new number in the assistant's reach without a row is a new way for it to
 * contradict the screen, and the whole point of this file is that there is no
 * such thing as a number only the assistant can see.
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   node test/chatdrift.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.DRIFT_PORT || 4530);
const STUB = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-drift-data');

const OWNER_EMAIL = 'drift@example.com';
const OWNER_PW = 'driftpass1';

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_d', type: 'message', role: 'assistant', content: next, usage: {} }));
  });
});

/* ------------------------------------------------------- a cookie jar ---- */

let cookie = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) {}
  return { status: res.status, body: parsed, raw };
}

/* ------------------------------------------ asking the assistant's side ---
 *
 * One question, one batch of tool calls. The model is allowed to ask for
 * several tools at once and the route runs them all, so every tool this file
 * cares about is fetched in a single trip — which also happens to exercise
 * the parallel path rather than only the one-at-a-time one.
 *
 * What comes back is read out of the SECOND request the server made to the
 * model, because that is where the tool results are: exactly the bytes the
 * model would have read. Nothing is recomputed here. */

const CALLS = [
  ['overview', 'get_overview', {}],
  ['screens', 'get_panel', { name: 'screens' }],
  ['ai', 'get_panel', { name: 'ai' }],
  ['storage', 'get_panel', { name: 'storage' }],
  ['gaps', 'get_panel', { name: 'gaps' }],
  ['public', 'get_panel', { name: 'public' }],
  ['weight', 'get_panel', { name: 'weight' }],
  ['commits', 'get_panel', { name: 'commits' }],
  ['dependencies', 'get_panel', { name: 'dependencies' }],
  ['changes', 'get_changes', { hours: 72 }],
  ['launch', 'get_launch_readiness', {}],
  ['usage', 'get_live_usage', {}],
];

async function askEverything(question) {
  seen = [];
  script = [
    CALLS.map(([key, name, input], i) => ({ type: 'tool_use', id: `tu_${i}`, name, input })),
    [{ type: 'tool_use', id: 'tu_done', name: 'deliver_answer', input: { answer: 'Read.' } }],
  ];
  const res = await call('POST', '/api/chat', {
    messages: [{ role: 'user', content: question }],
    register: 'technical',
  });
  if (res.status !== 200) throw new Error(`/api/chat answered ${res.status}: ${res.raw.slice(0, 300)}`);
  if (seen.length < 2) throw new Error(`the model was called ${seen.length} time(s); expected 2`);

  /* The tool results ride back as the last user turn of the second request. */
  /* The briefing is sent as two blocks now — a cached prefix and a live half —
     so the test keeps them apart as well as together. Which half a number is in
     is itself a thing worth asserting: a count that drifts into the prefix
     silently stops the cache ever hitting. */
  const blocks = Array.isArray(seen[0].system) ? seen[0].system : [{ text: seen[0].system }];
  const results = seen[1].messages[seen[1].messages.length - 1].content;
  const out = {
    _blocks: blocks,
    _prefix: blocks[0]?.text || '',
    _live: blocks.slice(1).map(b => b.text).join('\n'),
    _system: blocks.map(b => b.text).join('\n'),
    _raw: {},
  };
  CALLS.forEach(([key], i) => {
    const block = results.find(b => b.tool_use_id === `tu_${i}`);
    if (!block) throw new Error(`no tool result came back for ${key}`);
    out._raw[key] = block.content;
    out[key] = JSON.parse(block.content);
  });
  return out;
}

/* --------------------------------------------- reading the tabs' side ---- */

async function readTabs() {
  const scan = await call('GET', '/api/scan');
  if (scan.status !== 200) throw new Error(`/api/scan answered ${scan.status}`);
  const launch = await call('GET', '/api/launch');
  const changes = await call('GET', '/api/changes?hours=72');
  const pulse = await call('GET', '/api/pulse');
  return { scan: scan.body, launch: launch.body, changes: changes.body, pulse: pulse.body };
}

/* --------------------------------------------------------------- rows ---- *
 *
 * One row per number that can appear in an answer. Left: what the assistant
 * is handed. Right: what the tab is drawn from. They are compared with ===,
 * because "close enough" is exactly the failure this file exists to catch. */

const ROWS = [
  // — the headline counts, which the briefing also states in prose —
  ['screens',                  a => a.overview.screens,                 t => t.scan.screens.length],
  ['AI features',              a => a.overview.aiFeatures,              t => t.scan.ai.features.length],
  ['models in use',            a => a.overview.modelsInUse.length,      t => t.scan.ai.modelsInUse.length],
  ['data tables',              a => a.overview.dataTables,              t => t.scan.storage.tables.length],
  ['addresses with no login',  a => a.overview.addressesWithNoLogin,    t => t.scan.public.routes.length],
  ['link types with no login', a => a.overview.linkTypesWithNoLogin.length, t => t.scan.public.hashes.length],
  ['known gaps',               a => a.overview.knownGaps,               t => t.scan.gaps.gaps.length],
  ['files over the line',      a => a.overview.filesOverTheLine,        t => t.scan.weight.overThreshold],
  ['unused published names',   a => a.overview.unusedPublishedNames,    t => t.scan.weight.orphans.length],
  ['code version',             a => a.overview.codeVersion,             t => t.scan.commit],
  ['scanned at',               a => a.overview.scannedAt,               t => t.scan.scannedAt],
  ['repository',               a => a.overview.repository,              t => t.scan.repo],
  ['warnings the scan carries', a => a.overview.thingsTheScanCouldNotWorkOut.length, t => t.scan.warnings.length],

  // — the panels, which reach the same facts by a second route —
  ['screens panel',            a => a.screens.screens.length,           t => t.scan.screens.length],
  ['AI panel features',        a => a.ai.features.length,               t => t.scan.ai.features.length],
  ['storage panel tables',     a => a.storage.tables.length,            t => t.scan.storage.tables.length],
  ['gaps panel',               a => a.gaps.gaps.length,                 t => t.scan.gaps.gaps.length],
  ['public panel addresses',   a => a.public.addressesThatNeedNoLogin.length, t => t.scan.public.routes.length],
  ['public panel total routes', a => a.public.totalServerAddresses,     t => t.scan.public.totalRoutes],
  ['commits panel',            a => a.commits.commits.length,           t => t.scan.changes.length],
  ['dependency items',         a => a.dependencies.items.length,        t => t.scan.dependencies.items.length],

  /* This one is the reason the file exists. The assistant COUNTS the files it
     considers over the line, from the file list and the threshold; the tab is
     drawn from a total the scan worked out for itself. Two routes to one
     number is the shape every drift bug has. */
  ['weight panel counts its own', a => a.weight.filesOverTheLine.length, t => t.scan.weight.overThreshold],
  ['weight panel all files',   a => a.weight.allFiles.length,           t => t.scan.weight.files.length],
  ['weight panel orphans',     a => a.weight.publishedButNeverUsed.length, t => t.scan.weight.orphans.length],
  ['published names total',    a => a.weight.totalPublishedNames,       t => t.scan.weight.exportCount],

  // — money. The dashboard's own estimate, quoted in two places —
  ['today’s burn',             a => a.ai.moneyEstimates.dailyRealisticUsd, t => t.scan.cost.dailyMixedUsd],
  ['worst case',               a => a.ai.moneyEstimates.dailyWorstCaseUsd, t => t.scan.cost.dailyCeilingUsd],
  ['daily request limit',      a => a.ai.moneyEstimates.dailyRequestLimit, t => t.scan.cost.dailyLimit],
  ['prices last checked',      a => a.ai.moneyEstimates.pricesLastChecked, t => t.scan.cost.asOf],

  // — the change log. A different module and a different route on each side —
  ['changes in 72h',           a => a.changes.changes.length,           t => t.changes.rounds.length],
  ['change count',             a => a.changes.status.changeCount,       t => t.changes.changeCount],
  ['watching since',           a => a.changes.status.since,             t => t.changes.since],
  ['is watching',              a => a.changes.status.watching,          t => t.changes.watching],

  /* The worst possible thing for these two to disagree about is whether the
     owner is ready to launch, which is why the route works it out once and
     hands the same object to both. */
  ['launch verdict',           a => a.launch.verdict,                   t => VERDICT_PROSE(t.launch.verdict)],
  ['launch headline',          a => a.launch.inOneSentence,             t => t.launch.headline],
  ['needle position',          a => a.launch.needlePosition,            t => t.launch.needle],
  ['items done',               a => a.launch.itemsDone,                 t => t.launch.counts.done],
  ['items total',              a => a.launch.itemsTotal,                t => t.launch.counts.total],
  ['blocking a demo',          a => a.launch.blockingADemo,             t => t.launch.counts.demoOpen],
  ['blocking going live',      a => a.launch.blockingGoingLive,         t => t.launch.counts.liveOpen],
  ['items the Mapper cannot tell', a => a.launch.itemsTheMapperCannotTell, t => t.launch.counts.cantTell],
  ['ticks gone stale',         a => a.launch.ticksThatHaveGoneStale,    t => t.launch.counts.stale],
  ['outstanding items',        a => a.launch.outstanding.length,        t => t.launch.items.filter(i => !i.done).length],
  ['items already done',       a => a.launch.alreadyDone.length,        t => t.launch.items.filter(i => i.done).length],

  // — the live site, or the honest absence of it —
  ['live HaTi reachable',      a => a.usage.available,                  t => !!t.pulse.available],
];

/* get_launch_readiness turns the verdict into a sentence so the model never has
   to guess what "demo" means on its own. The mapping is part of the contract
   and is checked here rather than trusted. */
const VERDICT_PROSE = v => v === 'not-demo' ? 'not ready to demo yet'
  : v === 'demo' ? 'ready to demo, not ready for real customers'
    : 'ready to go live';

/* ------------------------------------------------------------- shapes ---- *
 *
 * A tool result reaches the model as JSON.stringify(out), and that is a lossy
 * door: undefined disappears entirely, NaN and Infinity both arrive as null.
 * So neither can be found by looking for itself on this side — but both leave
 * the same fingerprint, which is a fact the model needed and did not get.
 *
 * Hence two checks rather than one blanket walk. A key that should be there
 * and is missing catches undefined. A field that should be a finite number and
 * is null catches NaN and Infinity. A null everywhere else is left alone,
 * because "not detected" is a real and deliberate answer all over this
 * product. */

const REQUIRED = {
  overview: ['scannedAt', 'codeVersion', 'repository', 'screens', 'aiFeatures', 'modelsInUse',
    'dataTables', 'addressesWithNoLogin', 'linkTypesWithNoLogin', 'knownGaps',
    'filesOverTheLine', 'unusedPublishedNames', 'handWrittenMapWarnings',
    'thingsTheScanCouldNotWorkOut', 'changeLog'],
  screens: ['screens', 'valueStreams', 'filesDoingSeveralJobs'],
  ai: ['features', 'limitsWrittenInTheCode', 'routesUnderAiThatCostNothing', 'moneyEstimates'],
  storage: ['tables', 'thingsStoredInsideOneBlob', 'settingsKeys'],
  gaps: ['note', 'gaps'],
  public: ['linkTypesThatNeedNoLogin', 'addressesThatNeedNoLogin', 'totalServerAddresses'],
  weight: ['theLine', 'filesOverTheLine', 'allFiles', 'publishedButNeverUsed', 'totalPublishedNames'],
  commits: ['note', 'commitCountIsNotAChangeCount', 'commits'],
  dependencies: ['note', 'items', 'outOfDateWarnings'],
  changes: ['window', 'status', 'changes', 'nothingChanged'],
  launch: ['verdict', 'inOneSentence', 'needlePosition', 'itemsDone', 'itemsTotal',
    'blockingADemo', 'blockingGoingLive', 'itemsTheMapperCannotTell',
    'ticksThatHaveGoneStale', 'outstanding', 'alreadyDone'],
  usage: ['available'],
};

/* Fields the model will read as a number and put in a sentence. A null here is
   a hole where a figure should be, and the model has been told to quote what
   it fetched — so a hole becomes either a wrong answer or a missing one. */
const MUST_BE_FINITE = [
  ['overview', o => o.screens], ['overview', o => o.aiFeatures], ['overview', o => o.dataTables],
  ['overview', o => o.addressesWithNoLogin], ['overview', o => o.knownGaps],
  ['overview', o => o.filesOverTheLine], ['overview', o => o.unusedPublishedNames],
  ['weight', o => o.totalPublishedNames],
  ['launch', o => o.itemsDone], ['launch', o => o.itemsTotal], ['launch', o => o.needlePosition],
  ['launch', o => o.blockingADemo], ['launch', o => o.blockingGoingLive],
  ['launch', o => o.itemsTheMapperCannotTell], ['launch', o => o.ticksThatHaveGoneStale],
];

const shown = v => typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : JSON.stringify(v);

/* ---------------------------------------------------------------- run ---- */

fs.rmSync(DATA, { recursive: true, force: true });

const source = await hatiSource();
announce(source);

let server = null, sparseServer = null, sparseDir = null;

function boot(port, dataDir, env) {
  const s = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MAPPER_DATA: dataDir,
      MAPPER_OWNER_EMAIL: OWNER_EMAIL,
      ANTHROPIC_API_KEY: 'sk-ant-' + 'NOT-A-REAL-KEY-stand-in',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`,
      HATI_URL: '', MAPPER_TOKEN: '', RESEND_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', () => {});
  s.stderr.on('data', () => {});
  return s;
}

async function waitFor(base) {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`${base} never came up`);
}

try {
  await new Promise((resolve, reject) => stub.listen(STUB, resolve).on('error', reject));
  server = boot(PORT, DATA, source.env);
  await waitFor(BASE);

  console.log('\nHaTi-Mapper — the assistant against the tabs\n');

  const claimed = await call('POST', '/api/auth/setup', { email: OWNER_EMAIL, password: OWNER_PW });
  if (claimed.status !== 200) throw new Error(`could not claim the account: ${claimed.raw.slice(0, 200)}`);

  /* The tabs first, so the scan is cached before the assistant is asked —
     which is also the real order, since the page loads before the panel opens
     and /api/chat deliberately never triggers a scan of its own. */
  const tabs = await readTabs();
  const asked = await askEverything('Read everything you can.');

  /* ---- 1. every number the assistant is handed, against the tab ---- */
  console.log('Every number the assistant can quote, against the tab it comes from');
  for (const [name, fromAssistant, fromTab] of ROWS) {
    let a, t, err = null;
    try { a = fromAssistant(asked); } catch (e) { err = `assistant side threw: ${e.message}`; }
    try { t = fromTab(tabs); } catch (e) { err = err || `tab side threw: ${e.message}`; }
    check(name, !err && a === t,
      err || (a === t ? undefined : `assistant says ${shown(a)}, the tab is drawn from ${shown(t)}`));
  }

  /* ---- 2. the briefing states some of these in prose, by hand ---- */
  console.log('\nAnd the numbers written into the briefing by hand');
  const sys = asked._live || '';
  const briefed = [
    ['screens', tabs.scan.screens.length, /(\d+) screens/],
    ['AI features', tabs.scan.ai.features.length, /(\d+) features that call Anthropic/],
    ['data tables', tabs.scan.storage.tables.length, /(\d+) database tables/],
    ['open addresses', tabs.scan.public.routes.length, /(\d+) server addresses work without logging in/],
    ['known gaps', tabs.scan.gaps.gaps.length, /(\d+) known gaps are written down/],
    ['files over the line', tabs.scan.weight.overThreshold, /(\d+) files are over the 60 KB/],
    ['unused names', tabs.scan.weight.orphans.length, /(\d+) published names are never used/],
  ];
  for (const [name, expected, re] of briefed) {
    const m = sys.match(re);
    check(`the briefing’s ${name} matches the scan`, m ? Number(m[1]) === expected : false,
      m ? (Number(m[1]) === expected ? undefined : `briefing says ${m[1]}, the scan has ${expected}`)
        : `the briefing does not state it at all (${re})`);
  }
  const burn = sys.match(/"Today's burn" figure is \$([0-9.]+)/);
  check('the briefing’s money headline matches the Money tab',
    tabs.scan.cost?.dailyMixedUsd == null
      ? /no money figure could be estimated/.test(sys)
      : !!burn && Number(burn[1]) === Number(Number(tabs.scan.cost.dailyMixedUsd).toFixed(2)),
    burn ? `briefing $${burn[1]}, scan ${tabs.scan.cost?.dailyMixedUsd}` : 'no figure in the briefing');
  check('the briefing states the version the scan actually read',
    sys.includes(`Code version: ${tabs.scan.commit}`));

  /* ---- 2b. and none of them leaked into the half that is meant to cache ---- */
  console.log('\nAnd none of it leaked into the half that has to stay still');
  const pre = asked._prefix || '';
  check('the briefing is sent as a cached prefix and a live block',
    asked._blocks.length === 2 && !!asked._blocks[0].cache_control,
    `${asked._blocks.length} block(s), breakpoint ${JSON.stringify(asked._blocks[0]?.cache_control)}`);
  check('the cached half states no count from the scan',
    !/\d+ screens|\d+ features that call Anthropic|\d+ database tables|\d+ known gaps/.test(pre));
  check('nor the version, the scan time or the money headline',
    !pre.includes(tabs.scan.commit || ' ') && !/Last scanned:/.test(pre) &&
    !/Today's burn" figure is/.test(pre));
  check('nor which tab the owner happens to be on',
    !/WHERE THE OWNER IS LOOKING/.test(pre));
  check('but it does carry the rules, which is the whole point of caching it',
    /GROUND RULES — BOTH REGISTERS/.test(pre) && /YOU NAME ONE, YOU NEVER SUPPLY ITS NUMBERS/.test(pre) &&
    /WORDS IN THIS PRODUCT THAT MEAN MORE THAN ONE THING/.test(pre));
  check('and it is long enough to be worth caching at all',
    pre.length > 4000, `${pre.length} characters`);

  /* ---- 3. nothing the model needs went missing on the way ---- */
  console.log('\nNothing the model needs went missing on the way through');
  for (const [key, keys] of Object.entries(REQUIRED)) {
    const missing = keys.filter(k => !(k in asked[key]));
    check(`${key} carries every field it promises`, missing.length === 0, missing.join(', '));
  }
  for (const [key, read] of MUST_BE_FINITE) {
    const v = read(asked[key]);
    check(`${key}: a figure the model will quote is a real number`,
      typeof v === 'number' && isFinite(v), `got ${shown(v)}`);
  }
  /* Not in the list above, because it is legitimately unknowable: if the scan
     could not read HaTi's server file there is no total to give. What it must
     never be is absent, which is what an undefined becomes on the way through
     JSON — leaving the model holding a count of open doors with nothing to say
     what it is a count of. */
  check('the total number of addresses is a number when the server file was read',
    typeof asked.public.totalServerAddresses === 'number', shown(asked.public.totalServerAddresses));

  /* ---- 4. the same question twice gives the same bytes ---- */
  console.log('\nAsked twice against an unchanged scan');
  const again = await askEverything('Read everything you can.');
  const moved = CALLS.map(([k]) => k).filter(k => asked._raw[k] !== again._raw[k]);
  check('every tool answers identically', moved.length === 0,
    moved.length ? `these moved without the data moving: ${moved.join(', ')}` : undefined);

  /* ---- 5. two words that are not the same word ---- */
  console.log('\nChanges are not commits');
  check('the commits panel says its count is not a change count',
    asked.commits.commitCountIsNotAChangeCount === true);
  check('and an empty change log is a real answer rather than an error',
    typeof asked.changes.nothingChanged === 'boolean' && !asked.changes.error);
  check('the two are genuinely different numbers to get wrong',
    asked.commits.commits.length !== asked.changes.changes.length ||
    asked.changes.changes.length === 0,
    `commits ${asked.commits.commits.length}, observed changes ${asked.changes.changes.length}`);

  /* ---- 6. a workspace with almost nothing in it ----
     The Mapper says "not detected" a great deal, on purpose. What it must
     never do is fall over, or hand the model a hole where a count should be
     and let it guess. */
  console.log('\nA HaTi with almost nothing in it');
  sparseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-sparse-'));
  fs.mkdirSync(path.join(sparseDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(sparseDir, 'index.html'), '<!doctype html><title>nothing</title>\n');
  fs.writeFileSync(path.join(sparseDir, 'js', 'app.js'), '// nothing here yet\n');

  sparseServer = boot(PORT + 2, DATA + '-sparse', { HATI_FIXTURE: sparseDir });
  const sparseBase = `http://127.0.0.1:${PORT + 2}`;
  await waitFor(sparseBase);

  const before = { cookie, base: BASE };
  cookie = '';
  const sparseCall = async (m, p, b) => {
    const res = await fetch(sparseBase + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const setC = res.headers.get('set-cookie');
    if (setC) cookie = setC.split(';')[0];
    const raw = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {}
    return { status: res.status, body: parsed, raw };
  };

  await sparseCall('POST', '/api/auth/setup', { email: OWNER_EMAIL, password: OWNER_PW });
  const sparseScan = await sparseCall('GET', '/api/scan');
  check('a near-empty HaTi still scans rather than erroring', sparseScan.status === 200,
    sparseScan.status === 200 ? undefined : sparseScan.raw.slice(0, 200));

  seen = [];
  script = [
    CALLS.map(([key, name, input], i) => ({ type: 'tool_use', id: `tu_${i}`, name, input })),
    [{ type: 'tool_use', id: 'tu_done', name: 'deliver_answer', input: { answer: 'Read.' } }],
  ];
  const sparseChat = await sparseCall('POST', '/api/chat', {
    messages: [{ role: 'user', content: 'What is here?' }], register: 'plain',
  });
  check('and the assistant can still be asked about it', sparseChat.status === 200,
    sparseChat.status === 200 ? undefined : sparseChat.raw.slice(0, 200));

  if (sparseChat.status === 200 && seen.length >= 2) {
    const results = seen[1].messages[seen[1].messages.length - 1].content;
    const sparse = {};
    CALLS.forEach(([key], i) => {
      const b = results.find(x => x.tool_use_id === `tu_${i}`);
      if (b) sparse[key] = JSON.parse(b.content);
    });

    for (const [key, keys] of Object.entries(REQUIRED)) {
      if (!sparse[key]) { check(`${key} answered on a near-empty workspace`, false); continue; }
      const missing = keys.filter(k => !(k in sparse[key]));
      check(`${key} still carries every field it promises`, missing.length === 0, missing.join(', '));
    }
    for (const [key, read] of MUST_BE_FINITE) {
      if (!sparse[key]) continue;
      const v = read(sparse[key]);
      check(`${key}: still a real number with nothing to count`,
        typeof v === 'number' && isFinite(v), `got ${shown(v)}`);
    }
    /* The scanner cannot read a server file that is not there, so it does not
       know the total. It must say so rather than claim nought, and it must say
       so with the key present rather than by leaving it out. */
    check('an unreadable server file leaves the total known-unknown, not missing',
      'totalServerAddresses' in (sparse.public || {}) && sparse.public.totalServerAddresses === null,
      shown(sparse.public?.totalServerAddresses));
    check('and the scan itself says the same thing, so the tabs read it too',
      sparseScan.body?.public && 'totalRoutes' in sparseScan.body.public &&
      sparseScan.body.public.totalRoutes === null,
      shown(sparseScan.body?.public?.totalRoutes));
    check('an empty change log reports itself as empty, not as an error',
      sparse.changes && sparse.changes.nothingChanged === true && !sparse.changes.error);
    check('the launch checklist still returns a verdict',
      !!sparse.launch && typeof sparse.launch.verdict === 'string', JSON.stringify(sparse.launch?.verdict));
    check('and the unreachable live site says why rather than pretending',
      sparse.usage && sparse.usage.available === false && typeof sparse.usage.why === 'string',
      sparse.usage?.why);
  }

  cookie = before.cookie;
} catch (e) {
  check('The drift test itself completed', false, e.stack || String(e));
} finally {
  stub.close();
  if (server) server.kill();
  if (sparseServer) sparseServer.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(DATA + '-sparse', { recursive: true, force: true });
  if (sparseDir) fs.rmSync(sparseDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log('A failure here means the assistant would have told the owner a number the\n' +
    'screen beside it does not show. Fix the number, not the test.\n');
}
process.exit(fail ? 1 : 0);
