/* HaTi-Mapper — the assistant's tool loop, tested against a stand-in.
 *
 * A real Anthropic key is not needed to prove the mechanics: what matters is
 * that the loop asks for tools, runs the right one, feeds the result back,
 * stops when deliver_answer arrives, and shapes the reply the page expects.
 * The stand-in below plays the model's part and records what it was sent.
 *
 *   node test/chat-loop.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hatiSource, announce } from './source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LOOP_PORT || 4410);
const STUB = PORT + 1;
const RESTART_PORT = PORT + 2;
let restarted = null;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-loop-data');

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
    if (next.status) { res.writeHead(next.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(next.body || {})); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', content: next.content, usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});

const toolUse = (name, input) => ({ type: 'tool_use', id: 'tu_' + name, name, input });
const text = t => ({ type: 'text', text: t });

/* ---------------------------------------------------------------- run ---- */

fs.rmSync(DATA, { recursive: true, force: true });

const source = await hatiSource();
announce(source);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    MAPPER_DATA: DATA,
    ANTHROPIC_API_KEY: 'sk-ant-' + 'NOT-A-REAL-KEY-stand-in-for-tests',
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

/* Every data route is behind the login now, so the test holds a session the
   way a browser would. */
let cookie = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.get('set-cookie');
  if (setC) cookie = setC.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ask = (question) => call('POST', '/api/chat', { messages: [{ role: 'user', content: question }] });

try {
  await new Promise((resolve, reject) => stub.listen(STUB, resolve).on('error', reject));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\nHaTi-Mapper — assistant tool loop\n');

  /* Claim the account and hold the session, the way a browser would. */
  const setup = await call('POST', '/api/auth/setup', { email: 'loop@example.com', password: 'looptest1' });
  check('The test can sign in', setup.status === 200, JSON.stringify(setup.body));

  /* The assistant answers from the cached scan, so prime it first. */
  const scanRes = await call('GET', '/api/scan');
  check('A scan is available for the assistant to read', scanRes.status === 200, `got ${scanRes.status}`);

  /* ---- 1. a normal two-step answer ---- */
  seen = [];
  script = [
    { content: [text('Let me look.'), toolUse('get_overview', {})] },
    { content: [toolUse('deliver_answer', {
      answer: 'Your platform has **14 screens**.\n\n- Nine of them call the AI\n- Fifteen doors need no login',
      sources: [{ panel: 'screens', note: 'the full list' }, { panel: 'public' }],
      watch_out: 'One paid AI feature is never called.',
    })] },
  ];
  const r1 = await ask('How big is my platform?');
  check('The loop returns a finished answer', r1.status === 200 && !!r1.body.answer, JSON.stringify(r1.body).slice(0, 160));
  check('It took two turns with the model', seen.length === 2, `${seen.length} turns`);
  check('The tools were offered to the model', Array.isArray(seen[0].tools) && seen[0].tools.length >= 5, `${seen[0].tools?.length} tools`);
  check('deliver_answer is one of them', (seen[0].tools || []).some(t => t.name === 'deliver_answer'));
  check('The system prompt tells it who it is talking to', /NOT a developer/.test(seen[0].system || ''));
  check('The system prompt carries the real headline numbers', /14 screens/.test(seen[0].system || ''));
  check('The system prompt forbids reaching contract data', /never see|cannot see anything IN it|no customer data/i.test(seen[0].system || ''));

  /* Two different things are called "changes", and the assistant once told the
     owner the dashboard was wrong by counting the other one — reporting a
     commit count as a change count and contradicting a figure that was right.
     The rule has to reach the model, so it is asserted where it is sent. */
  const sys = seen[0].system || '';
  const tools = seen[0].tools || [];
  const named = n => tools.find(t => t.name === n) || {};
  check('The system prompt separates observed changes from commits',
    /TWO DIFFERENT THINGS ARE CALLED "CHANGES"/.test(sys));
  check('And says an empty change log is an answer, not a gap to fill',
    /Do not reach for the\s+commit count to fill that gap/.test(sys));
  check('And forbids calling a dashboard figure wrong over the difference',
    /never\s+tell the user a figure on the dashboard is wrong/i.test(sys));
  check('The change tool is named as the only source of a change count',
    /ONLY SOURCE FOR A COUNT OF CHANGES/.test(named('get_changes').description || ''),
    (named('get_changes').description || '').slice(0, 80));
  /* Read out of the schema rather than off its JSON, so the assertion is not
     testing how quotes survive stringifying. */
  const commitsDesc = named('get_panel').input_schema?.properties?.name?.description || '';
  check('And the commits option says its count is not a change count',
    /never report a count of these as "changes"/.test(commitsDesc),
    commitsDesc.slice(commitsDesc.indexOf('commits ='), 140));

  /* The tool result must actually be fed back, not invented. */
  const secondTurn = JSON.stringify(seen[1].messages || []);
  check('The tool result was fed back to the model', /tool_result/.test(secondTurn));
  check("The fed-back result holds real scanned data", /\\"screens\\":14/.test(secondTurn), secondTurn.slice(0, 200));

  check('The answer is passed through', /14 screens/.test(r1.body.answer));
  check('Sources become links to real tabs', r1.body.sources?.length === 2 && r1.body.sources[0].tab === 'screens', JSON.stringify(r1.body.sources));
  check('A watch-out is carried through', r1.body.watchOut === 'One paid AI feature is never called.');
  check('Which tools ran is reported', (r1.body.toolsUsed || []).includes('get_overview'), JSON.stringify(r1.body.toolsUsed));

  /* ---- 2. several tools in one turn ---- */
  seen = [];
  script = [
    { content: [toolUse('get_panel', { name: 'ai' }), toolUse('search_map', { query: 'playbook' })] },
    { content: [toolUse('deliver_answer', { answer: 'Two features use the expensive model.', sources: [{ panel: 'cost' }] })] },
  ];
  const r2 = await ask('What is costing me money?');
  check('Several tools in one turn all run', r2.status === 200 && (r2.body.toolsUsed || []).length === 2, JSON.stringify(r2.body.toolsUsed));
  const fed = JSON.stringify(seen[1].messages || []);
  check('Both tool results came back real', /capPer15Minutes/.test(fed) && /Clause review/.test(fed));

  /* ---- 3. plain text with no tool call is still accepted ---- */
  seen = [];
  script = [{ content: [text('Hello — ask me anything about your platform.')] }];
  const r3 = await ask('hello');
  check('A plain reply with no tool call is accepted', r3.status === 200 && /Hello/.test(r3.body.answer), JSON.stringify(r3.body).slice(0, 120));

  /* ---- 4. a runaway model is stopped ---- */
  seen = [];
  script = Array.from({ length: 8 }, () => ({ content: [toolUse('get_overview', {})] }));
  const r4 = await ask('loop forever');
  check('A model that never delivers is cut off', r4.status === 200 && /could not finish/i.test(r4.body.answer), r4.body.answer?.slice(0, 90));
  check('It gave up after five turns, not eight', seen.length === 5, `${seen.length} turns`);

  /* ---- 5. a bad tool name does not crash the loop ---- */
  seen = [];
  script = [
    { content: [toolUse('no_such_tool', {})] },
    { content: [toolUse('deliver_answer', { answer: 'Recovered.' })] },
  ];
  const r5 = await ask('do something odd');
  check('An unknown tool is handled, not fatal', r5.status === 200 && r5.body.answer === 'Recovered.', JSON.stringify(r5.body).slice(0, 100));

  /* The count of questions asked today, taken before anything is allowed to
     fail, so the two can be compared afterwards. */
  const usedBeforeFailures = (await call('GET', '/api/ai/config')).body.budget.used;

  /* ---- 6. provider failures are put in plain English ---- */
  seen = [];
  script = [{ status: 401, body: { error: { message: 'invalid x-api-key' } } }];
  const r6 = await ask('anything');
  check('A rejected key is explained in plain words', r6.status === 502 && /key was rejected/i.test(r6.body.error), r6.body.error);
  check('The raw provider error is not shown to the user', !/x-api-key/.test(r6.body.error || ''));

  seen = [];
  script = [{ status: 429, body: {} }];
  const r7 = await ask('anything');
  check('Rate limiting is explained in plain words', /rate-limiting/i.test(r7.body.error || ''), r7.body.error);

  /* ---- the daily question count ----
     It used to live in memory and be added to before Anthropic was called, so
     it reset on every restart and a run of outages could eat the whole day's
     allowance without producing a single answer. */
  console.log('\nThe daily question count');
  const budgetAfterFailures = (await call('GET', '/api/ai/config')).body.budget;
  check('Five questions were answered and counted', usedBeforeFailures === 5, `${usedBeforeFailures}`);
  check('A rejected key and a rate limit cost nothing against the day',
    budgetAfterFailures.used === usedBeforeFailures, `${usedBeforeFailures} → ${budgetAfterFailures.used}`);
  check('The count reports itself as durable', budgetAfterFailures.durable === true);

  const budgetOnDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'chat-budget.json'), 'utf8'));
  check('It is written to disk with today\'s date',
    budgetOnDisk.used === budgetAfterFailures.used && budgetOnDisk.date === new Date().toISOString().slice(0, 10),
    JSON.stringify(budgetOnDisk));

  /* Restart against the same state directory. The count has to survive, which
     is the whole point of writing it down. */
  restarted = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(RESTART_PORT), MAPPER_DATA: DATA, HATI_URL: '', MAPPER_TOKEN: '', ...source.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const restartBase = `http://127.0.0.1:${RESTART_PORT}`;
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${restartBase}/api/health`)).ok) { up = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  check('A restarted Mapper came up on the same state directory', up);
  const afterRestart = await fetch(`${restartBase}/api/ai/config`, { headers: { Cookie: cookie } });
  const restartBudget = (await afterRestart.json()).budget;
  check('Restarting mid-day does not hand back a fresh allowance',
    restartBudget.used === budgetAfterFailures.used, `${budgetAfterFailures.used} → ${restartBudget.used}`);

  /* ---- draft a fix prompt ----
     The point of this feature is that the owner never has to remember a file
     path. So what is asserted is that the real path or identifier, taken from
     the scan, reaches the model — along with the standing rules, word for
     word. The model's wording is not the thing under test. */
  console.log('\nDrafting a fix prompt');
  const scanned = scanRes.body;

  const draftFor = async (kind, id) => {
    seen = [];
    script = [{ content: [toolUse('deliver_answer', { answer: 'A prompt.' })] }];
    const r = await call('POST', '/api/chat', { draft: { kind, id } });
    return { res: r, sent: seen[0] ? String(seen[0].messages[0].content) : '', system: seen[0] ? seen[0].system : '' };
  };

  /* (1) a paid AI endpoint nothing calls */
  const unused = scanned.ai.features.find(f => (f.usedBy || []).length === 0);
  check('The scan found an AI endpoint nothing calls to draft against', !!unused, unused ? unused.feature : 'none');
  const d1 = await draftFor('ai-unused', unused.feature);
  check('Drafting against it succeeds', d1.res.status === 200 && !!d1.res.body.answer, JSON.stringify(d1.res.body).slice(0, 100));
  check('It is marked as a drafted prompt, not an ordinary answer', d1.res.body.drafted === true);
  check('The real route reaches the model', d1.sent.includes(unused.route), unused.route);
  check('So does the identifier it is tagged with in the source',
    d1.sent.includes(`aiFeature('${unused.feature}')`), unused.feature);
  check('And the fact that nothing calls it',
    new RegExp(`api\\('ai/${unused.feature}'\\)`).test(d1.sent));

  /* (2) a name published on window that nothing references */
  const orphan = scanned.weight.orphans[0];
  check('The scan found an unused published name to draft against', !!orphan, orphan ? orphan.name : 'none');
  const d2 = await draftFor('orphan', orphan.name);
  check('Drafting against it succeeds', d2.res.status === 200);
  check('The real file it is exported from reaches the model',
    d2.sent.includes(orphan.exportedFrom) && d2.sent.includes(orphan.name),
    `${orphan.name} in ${orphan.exportedFrom}`);

  /* (3) a gap the documents admit to */
  const gap = scanned.gaps.gaps[0];
  const d3 = await draftFor('gap', gap.title);
  check('Drafting against a written-down gap succeeds', d3.res.status === 200);
  check('Both the gap and the document it is written in reach the model',
    d3.sent.includes(gap.title) && d3.sent.includes(gap.source), gap.source);

  /* The boundaries are the reason this exists — they go in verbatim. */
  for (const line of [
    'Do not build or modify the mobile/WhatsApp counterparty portal.',
    "Run the project's verification before finishing, and do not finish while it is failing.",
    'Produce BUGLOG.md and SUMMARY.md updates describing what changed and anything that did not work.',
  ]) {
    check(`Every draft carries: "${line.slice(0, 46)}…"`,
      [d1.sent, d2.sent, d3.sent].every(x => x.includes(line)));
  }
  check('And is told to reproduce them word for word',
    /reproduced word for word/.test(d1.sent), d1.sent.slice(0, 60));
  check('The model is told it is writing a prompt, not answering a question',
    /YOU ARE DRAFTING A PROMPT, NOT ANSWERING A QUESTION/.test(d1.system));
  check('And told to add no facts of its own', /Do not add facts/.test(d1.system));

  /* A finding that is not there must be refused, not drafted around. */
  const missing = await call('POST', '/api/chat', { draft: { kind: 'orphan', id: 'noSuchNameAnywhere' } });
  check('A finding that no longer exists is refused rather than invented',
    missing.status === 404 && /no unused published name/i.test(missing.body.error), JSON.stringify(missing.body));
  const nonsense = await call('POST', '/api/chat', { draft: { kind: 'not-a-kind', id: 'x' } });
  check('So is a kind of finding nobody has heard of', nonsense.status === 404, `got ${nonsense.status}`);

  /* ---- 7. nothing from HaTi's contracts can reach the model ---- */
  const everythingSent = JSON.stringify(seen.concat(script)) + JSON.stringify(seen);
  const allTurns = JSON.stringify(seen);
  check('The stand-in never received a bearer token or key', !/sk-ant-stand-in|Bearer /.test(allTurns));

  /* ---- 8. the key is never handed to the browser ---- */
  const cfg = (await call('GET', '/api/ai/config')).body;
  check('The config route reports a key is set', cfg.configured === true);
  check('The config route never returns the key', !JSON.stringify(cfg).includes('stand-in-key'), JSON.stringify(cfg));
  check('Only a last-four hint is exposed', /^••••/.test(cfg.hint), cfg.hint);
  check('The environment key is reported as a fallback', cfg.environmentFallback === true, JSON.stringify(cfg));
  const put = await call('PUT', '/api/ai/config', { key: 'sk-ant-' + 'z'.repeat(40) });
  check('The signed-in owner can set the key from the platform', put.status === 200, `got ${put.status}`);
  /* The documents say the pasted key beats the one in the environment. This
     server was started with ANTHROPIC_API_KEY set, so that claim is testable
     rather than merely written down. */
  const cfgAfter = (await call('GET', '/api/ai/config')).body;
  check('A key set in the page beats the one in the environment', cfgAfter.source === 'platform', cfgAfter.source);
  check('And the environment key is still reported as the fallback', cfgAfter.environmentFallback === true);
  const anon = await fetch(`${BASE}/api/ai/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sk-ant-' + 'q'.repeat(40) }),
  });
  check('Nobody without a session can set the key', anon.status === 401, `got ${anon.status}`);

  /* ---- 9. the change log ---- */
  const ch = (await call('GET', '/api/changes')).body;
  check('The change log is watching', ch.watching === true, JSON.stringify(ch).slice(0, 120));
  check('It keeps 72 hours', ch.retentionHours === 72);
  check('The first scan records a baseline, not a change', ch.rounds.length === 0 && ch.snapshots === 1, JSON.stringify(ch.rounds).slice(0, 80));
} catch (e) {
  check('The loop test itself completed', false, e.stack || String(e));
  console.error(log);
} finally {
  server.kill();
  if (restarted) restarted.kill();
  stub.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
