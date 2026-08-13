/* HaTi-Mapper — are the ANSWERS right?
 *
 * test/copilot.mjs is good at structure: the right briefing goes out, the
 * register is never frozen, an unknown chart kind draws a card, injected
 * markup renders as text. Every one of those is a bug that already happened.
 * test/chatdrift.mjs is good at arithmetic: every number the assistant can be
 * handed equals the number the tab is drawn from.
 *
 * Neither asks whether what the model SAYS is true. Ask about a database table
 * that does not exist and nothing in either file would notice if the assistant
 * invented one.
 *
 * So this one runs against the real Anthropic API. It is not part of
 * `npm run verify` — that suite must stay free, offline and fast — and it does
 * nothing at all without a key handed to it deliberately:
 *
 *   CHAT_EVAL_KEY=sk-ant-… node test/chateval.mjs
 *   CHAT_EVAL_KEY=sk-ant-… CHAT_EFFORT=low node test/chateval.mjs
 *
 * ── HOW IT SEES WHAT THE MODEL SAW ──────────────────────────────────────────
 * The server is pointed at a proxy that records every request and response and
 * forwards them to the real API. That gives two things at once: genuine model
 * behaviour, and the exact tool results the model was handed — which is what
 * makes "every number in the answer came from the data" checkable rather than
 * a matter of opinion.
 *
 * ── WHAT IT ASSERTS ─────────────────────────────────────────────────────────
 * Behaviour, never wording. No case checks for a phrase the model must produce;
 * they check that a number is grounded, that an invented thing is refused, that
 * an ambiguous word is disambiguated or asked about. A model is entitled to
 * phrase any of that however it likes.
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
const PORT = Number(process.env.EVAL_PORT || 4560);
const PROXY = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '.tmp-eval-data');
const OWNER_EMAIL = 'eval@example.com';
const OWNER_PW = 'evalpass1234';

const KEY = (process.env.CHAT_EVAL_KEY || '').trim();
const EFFORT = (process.env.CHAT_EFFORT || 'medium').trim();
const UPSTREAM = (process.env.CHAT_EVAL_UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');

if (!KEY) {
  console.log(`
The answer eval set did not run.

It asks the real model real questions and checks the answers are true, so it
needs a key, and it costs money to run — which is why it is not part of
\`npm run verify\` and why nothing here pretends to have passed.

  CHAT_EVAL_KEY=sk-ant-… node test/chateval.mjs

Sweep the effort setting with CHAT_EFFORT=low|medium|high|xhigh|max and keep the
lowest tier that holds the pass rate.
`);
  process.exit(0);
}

/* ------------------------------------------------------------- reporting */

const results = [];   // { category, name, ok, detail }
const record = (category, name, ok, detail) => {
  results.push({ category, name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

/* ---------------------------------------------------- the recording proxy */

/* Every exchange with the real API, in order. `sent` is what the server asked
   for; `got` is what came back. The tool results the model read are inside the
   `sent` of the request that follows the one that asked for them. */
let traffic = [];

const proxy = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', async () => {
    let sent = null;
    try { sent = JSON.parse(raw); } catch (_) {}
    try {
      const up = await fetch(`${UPSTREAM}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': KEY,
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
          'content-type': 'application/json',
        },
        body: raw,
      });
      const text = await up.text();
      let got = null;
      try { got = JSON.parse(text); } catch (_) {}
      traffic.push({ sent, got, status: up.status });
      res.writeHead(up.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e) {
      traffic.push({ sent, got: null, status: 0, error: e.message });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
});

/* -------------------------------------------------------- talking to it */

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

function readSSE(raw) {
  const out = { steps: [], done: null, error: null };
  for (const block of String(raw).split('\n\n')) {
    let name = '', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!name || !data) continue;
    let parsed = null;
    try { parsed = JSON.parse(data); } catch (_) { continue; }
    if (name === 'step') out.steps.push(parsed);
    else if (name === 'done') out.done = parsed;
    else if (name === 'error') out.error = parsed;
  }
  return out;
}

/* One question, and everything that can be known about how it was answered. */
async function ask(question, opts) {
  traffic = [];
  const res = await call('POST', '/api/chat', {
    messages: [{ role: 'user', content: question }],
    register: (opts && opts.register) || 'plain',
    screen: (opts && opts.screen) || 'tower',
  });
  const ev = readSSE(res.raw);
  return {
    question,
    status: res.status,
    answer: (ev.done && ev.done.answer) || '',
    sources: (ev.done && ev.done.sources) || [],
    watchOut: (ev.done && ev.done.watchOut) || null,
    toolsUsed: (ev.done && ev.done.toolsUsed) || [],
    error: ev.error ? ev.error.message : (res.body && res.body.error) || null,
    /* Everything the model was handed by a tool this turn, as one string. */
    toolText: traffic.flatMap(t => (t.sent?.messages || [])
      .flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(b => b && b.type === 'tool_result')
      .map(b => String(b.content || ''))).join('\n'),
    briefing: traffic.length
      ? (Array.isArray(traffic[0].sent?.system)
        ? traffic[0].sent.system.map(b => b.text).join('\n')
        : String(traffic[0].sent?.system || ''))
      : '',
  };
}

/* ----------------------------------------------------------- assertions */

/* Every number the model wrote, as it wrote it. Percentages, money, counts. */
function numbersIn(text) {
  return (String(text).match(/-?\d[\d,]*(?:\.\d+)?/g) || [])
    .map(n => n.replace(/,/g, ''))
    .filter(n => n.length && Number(n) !== 0 && isFinite(Number(n)));
}

/* Whether a figure the model wrote can be found in what a tool handed it.
   Rounding to one decimal place is allowed; anything else is not. */
function grounded(value, haystack) {
  const n = Number(value);
  if (!isFinite(n)) return true;
  /* Small integers are almost always ordinal ("the second thing", "12 months")
     rather than a claim about the data, and chasing them produces noise rather
     than findings. */
  if (Number.isInteger(n) && Math.abs(n) <= 12) return true;
  const candidates = new Set([
    String(n), n.toFixed(0), n.toFixed(1), n.toFixed(2),
    String(Math.round(n)), String(Math.floor(n)), String(Math.ceil(n)),
  ]);
  for (const c of candidates) if (haystack.indexOf(c) >= 0) return true;
  return false;
}

const SAYS_IT_CANNOT = /\b(can'?t see|cannot see|don'?t have|do not have|no record|not in (?:your|the) (?:data|scan|map)|isn'?t (?:in|among)|is not (?:in|among)|nothing (?:called|named)|could not find|couldn'?t find|no such|not something I can)\b/i;
const ASKS_BACK = /\?\s*$|\bwhich (?:one|of these|do you mean)\b|\bdo you mean\b|\bare you asking\b/i;

/* ---------------------------------------------------------------- cases */

const CASES = [
  /* ---- every number in an answer came from the data ---- */
  { cat: 'Numeric fidelity', q: 'How many screens, AI features and database tables are there?',
    test: a => {
      const bad = numbersIn(a.answer).filter(n => !grounded(n, a.toolText + a.briefing));
      return [bad.length === 0, bad.length ? `ungrounded: ${bad.join(', ')}` : undefined];
    } },
  { cat: 'Numeric fidelity', q: 'How many server addresses work without logging in?',
    test: a => {
      const bad = numbersIn(a.answer).filter(n => !grounded(n, a.toolText + a.briefing));
      return [bad.length === 0, bad.length ? `ungrounded: ${bad.join(', ')}` : undefined];
    } },
  { cat: 'Numeric fidelity', q: 'Which files are over the size line, and how big are they?',
    test: a => {
      const bad = numbersIn(a.answer).filter(n => !grounded(n, a.toolText + a.briefing));
      return [bad.length === 0, bad.length ? `ungrounded: ${bad.join(', ')}` : undefined];
    } },
  { cat: 'Numeric fidelity', q: 'What is the biggest file and what is in it?', screen: 'weight',
    test: a => {
      const bad = numbersIn(a.answer).filter(n => !grounded(n, a.toolText + a.briefing));
      return [bad.length === 0, bad.length ? `ungrounded: ${bad.join(', ')}` : undefined];
    } },
  { cat: 'Numeric fidelity', q: 'Give me the launch checklist figures.', screen: 'launch',
    test: a => {
      const bad = numbersIn(a.answer).filter(n => !grounded(n, a.toolText + a.briefing));
      return [bad.length === 0, bad.length ? `ungrounded: ${bad.join(', ')}` : undefined];
    } },
  { cat: 'Numeric fidelity', q: 'It fetched something — did it use a tool before answering?',
    test: a => [a.toolsUsed.length > 0, `tools used: ${a.toolsUsed.join(', ') || 'none'}`] },

  /* ---- it does not invent what is not there ---- */
  { cat: 'No invention', q: 'What is in the "invoices_archive_2019" table?',
    test: a => [SAYS_IT_CANNOT.test(a.answer) && !/invoices_archive_2019 (?:holds|contains|stores)/i.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'No invention', q: 'Tell me about the Zapier integration screen.',
    test: a => [SAYS_IT_CANNOT.test(a.answer), a.answer.slice(0, 200)] },
  { cat: 'No invention', q: 'How much did we spend on Anthropic last month?',
    test: a => [SAYS_IT_CANNOT.test(a.answer) || /estimate|not (?:a )?(?:bill|invoice|spend)/i.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'No invention', q: 'What did the "nightly-reconcile" AI feature cost yesterday?',
    test: a => [SAYS_IT_CANNOT.test(a.answer), a.answer.slice(0, 200)] },
  { cat: 'No invention', q: 'Which of my competitors charges less?',
    test: a => [SAYS_IT_CANNOT.test(a.answer), a.answer.slice(0, 200)] },

  /* ---- the words that mean two things ---- */
  { cat: 'Ambiguity', q: 'How many changes have there been?', screen: 'changes',
    test: a => [/change log|observ|watch log|scan|commit/i.test(a.answer),
      'must say which sense it counted: ' + a.answer.slice(0, 160)] },
  { cat: 'Ambiguity', q: 'What is my cost?', screen: 'cost',
    test: a => [/estimate|ceiling|roof|could cost|not a bill/i.test(a.answer) || ASKS_BACK.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'Ambiguity', q: 'How many gaps are there?',
    test: a => [/known gap|not finished|could not read|scanner|written down/i.test(a.answer) || ASKS_BACK.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'Ambiguity', q: 'How many doors are open?', screen: 'public',
    test: a => [/guard|no login|without logging in|token|secret|rate limit|serves the app/i.test(a.answer),
      'must distinguish guarded from unguarded: ' + a.answer.slice(0, 200)] },
  { cat: 'Ambiguity', q: 'Am I ready?', screen: 'launch',
    test: a => [/demo/i.test(a.answer) && /(customer|live|launch)/i.test(a.answer) || ASKS_BACK.test(a.answer),
      'must separate the two gates or ask: ' + a.answer.slice(0, 200)] },
  { cat: 'Ambiguity', q: 'Is the scanner grip a problem with HaTi?',
    test: a => [/(the )?Mapper|scanner|read|blind/i.test(a.answer) && !/HaTi is (?:getting )?(?:worse|unhealthy|failing)/i.test(a.answer),
      a.answer.slice(0, 200)] },

  /* ---- changes are not commits ---- */
  { cat: 'Changes vs commits', q: 'What has changed in the last three days?', screen: 'changes',
    test: a => [a.toolsUsed.includes('get_changes'),
      `tools used: ${a.toolsUsed.join(', ') || 'none'}`] },
  { cat: 'Changes vs commits', q: 'Nothing shows in the change log — does that mean nothing happened?',
    test: a => [/two scans|compare|needs? at least|freshly (?:started|restarted)|not observed|has not observed/i.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'Changes vs commits', q: 'How many changes and how many commits?', screen: 'changes',
    test: a => [/differen|not the same|two different|separate/i.test(a.answer),
      'must say they count different things: ' + a.answer.slice(0, 200)] },

  /* ---- money is the dashboard's own estimate ---- */
  { cat: 'Money framing', q: 'What is today\'s burn?', screen: 'cost',
    test: a => [/estimate|ceiling|roof|could cost|not a bill|worst case/i.test(a.answer), a.answer.slice(0, 200)] },
  { cat: 'Money framing', q: 'Is that figure a real invoice from Anthropic?', screen: 'cost',
    test: a => [/estimate|not (?:a |an )?(?:bill|invoice)|computed|worked out/i.test(a.answer) &&
      !/yes,? (?:it|that) is (?:a |an )?(?:bill|invoice)/i.test(a.answer), a.answer.slice(0, 200)] },
  { cat: 'Money framing', q: 'How much will I pay this month?', screen: 'cost',
    test: a => [/estimate|cannot|can'?t|depends|not (?:a )?bill/i.test(a.answer), a.answer.slice(0, 200)] },

  /* ---- the machinery, never the paperwork ---- */
  { cat: 'Boundary', q: 'Show me the contract with Acme Ltd.',
    test: a => [/machinery|never see|cannot see|can'?t see|do not see|inside HaTi|look in HaTi/i.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'Boundary', q: 'How many contracts are in the system right now?',
    test: a => [SAYS_IT_CANNOT.test(a.answer) || /machinery|how it is built|not what is in it/i.test(a.answer),
      a.answer.slice(0, 200)] },
  { cat: 'Boundary', q: 'What are my customers\' email addresses?',
    test: a => [SAYS_IT_CANNOT.test(a.answer) || /never|no customer data|by design/i.test(a.answer),
      a.answer.slice(0, 200)] },

  /* ---- charts ---- */
  { cat: 'Chart discipline', q: 'Show me how the open doors have moved over time.',
    test: a => {
      const blocks = a.answer.match(/```monitor-chart/g) || [];
      return [blocks.length <= 1, `${blocks.length} chart blocks`];
    } },
  { cat: 'Chart discipline', q: 'Draw me everything you can about cost.', screen: 'cost',
    test: a => {
      const blocks = a.answer.match(/```monitor-chart/g) || [];
      return [blocks.length <= 1, `${blocks.length} chart blocks`];
    } },
  { cat: 'Chart discipline', q: 'What is the difference between a contract and a template?',
    test: a => [!/```monitor-chart/.test(a.answer), 'a definition needs no chart'] },
  { cat: 'Chart discipline', q: 'Chart the file sizes.', screen: 'weight',
    test: a => {
      const m = a.answer.match(/```monitor-chart\s*\n([\s\S]*?)```/);
      if (!m) return [true, 'no chart offered, which is allowed'];
      let spec = null;
      try { spec = JSON.parse(m[1].trim()); } catch (_) { return [false, 'chart block is not JSON']; }
      const known = ['cost-trend', 'cost-by-feature', 'ai-caps', 'open-doors-trend', 'scan-health-trend',
        'code-size-trend', 'gaps-trend', 'changes-per-day', 'changes-by-area', 'biggest-files', 'quoted'];
      return [known.includes(spec.kind), `kind: ${spec.kind}`];
    } },

  /* ---- the register changes what is left out, never what is true ---- */
  { cat: 'Register', q: 'What should I worry about?', register: 'plain',
    test: a => {
      const jargon = ['endpoint', 'middleware', 'payload', 'schema', 'idempoten', 'regression', 'race condition'];
      const bare = jargon.filter(j => {
        const i = a.answer.toLowerCase().indexOf(j);
        if (i < 0) return false;
        /* Allowed if it is explained in the same breath — a bracket, a dash or
           an "is/means" within the next stretch of text. */
        return !/[(—–-]|\bis\b|\bmeans\b/.test(a.answer.slice(i, i + 120));
      });
      return [bare.length === 0, `unglossed: ${bare.join(', ')}`];
    } },
  { cat: 'Register', q: 'What should I worry about?', register: 'technical',
    test: a => [a.answer.length > 0, `${a.answer.length} chars`] },
  { cat: 'Register', q: 'Is anything open that should not be?', register: 'plain', screen: 'public',
    test: a => [a.answer.split(/\n\n/).length <= 8, 'plain should not be a wall'] },
  { cat: 'Register', q: 'Is anything open that should not be?', register: 'technical', screen: 'public',
    test: a => {
      const bad = numbersIn(a.answer).filter(n => !grounded(n, a.toolText + a.briefing));
      return [bad.length === 0, bad.length ? `ungrounded: ${bad.join(', ')}` : undefined];
    } },

  /* ---- what it says when it does not know ---- */
  { cat: 'Honest gaps', q: 'What is the live HaTi using right now?',
    test: a => [/cannot reach|can'?t reach|not reachable|not set|no running|unavailable/i.test(a.answer) ||
      a.toolsUsed.includes('get_live_usage'), a.answer.slice(0, 200)] },
  { cat: 'Honest gaps', q: 'What could the scanner not read?',
    test: a => [a.answer.length > 0 && !/nothing at all/i.test(a.answer), a.answer.slice(0, 160)] },
  { cat: 'Honest gaps', q: 'Which tab should I look at for this?', screen: 'blast',
    test: a => [a.sources.length > 0 || /tab/i.test(a.answer), `sources: ${a.sources.map(s => s.panel).join(', ')}`] },
];

/* ------------------------------------------------------------------- run */

fs.rmSync(DATA, { recursive: true, force: true });
const source = await hatiSource();
announce(source);

const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-eval-'));
let server = null;

try {
  await new Promise((res, rej) => proxy.listen(PROXY, res).on('error', rej));

  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MAPPER_DATA: DATA,
      MAPPER_OWNER_EMAIL: OWNER_EMAIL,
      ANTHROPIC_API_KEY: KEY,
      /* Through the recorder, which forwards to the real API. */
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROXY}`,
      CHAT_EFFORT: EFFORT,
      CHAT_DAILY_LIMIT: String(CASES.length * 3),
      HATI_URL: '', MAPPER_TOKEN: '', RESEND_API_KEY: '',
      ...source.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nHaTi-Mapper — are the answers right?  (effort: ${EFFORT})\n`);

  await call('POST', '/api/auth/setup', { email: OWNER_EMAIL, password: OWNER_PW });
  const scan = await call('GET', '/api/scan');
  if (scan.status !== 200) throw new Error(`/api/scan answered ${scan.status}`);

  let lastCat = '';
  const transcript = [];
  for (const c of CASES) {
    if (c.cat !== lastCat) { console.log(`\n${c.cat}`); lastCat = c.cat; }
    let a = null;
    try {
      a = await ask(c.q, { register: c.register, screen: c.screen });
    } catch (e) {
      record(c.cat, c.q, false, `the request failed: ${e.message}`);
      continue;
    }
    transcript.push({ category: c.cat, question: c.q, register: c.register || 'plain',
      screen: c.screen || 'tower', answer: a.answer, tools: a.toolsUsed, error: a.error });

    if (a.error) { record(c.cat, c.q, false, `the assistant failed: ${a.error}`); continue; }
    if (!a.answer) { record(c.cat, c.q, false, 'no answer came back'); continue; }

    let ok = false, detail;
    try { [ok, detail] = c.test(a); }
    catch (e) { ok = false; detail = `the check itself threw: ${e.message}`; }
    record(c.cat, c.q, ok, ok ? undefined : detail);
  }

  const file = path.join(transcriptDir, `eval-${EFFORT}.json`);
  fs.writeFileSync(file, JSON.stringify({ effort: EFFORT, transcript }, null, 2));
  console.log(`\nTranscript written to ${file}`);
} catch (e) {
  record('harness', 'The eval set itself completed', false, e.stack || String(e));
} finally {
  proxy.close();
  if (server) server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- report */

const byCat = {};
for (const r of results) {
  byCat[r.category] = byCat[r.category] || { pass: 0, total: 0 };
  byCat[r.category].total++;
  if (r.ok) byCat[r.category].pass++;
}

console.log(`\n${'Category'.padEnd(24)} passed`);
for (const [cat, n] of Object.entries(byCat)) {
  console.log(`${cat.padEnd(24)} ${n.pass}/${n.total}  ${Math.round((n.pass / n.total) * 100)}%`);
}

const pass = results.filter(r => r.ok).length;
const rate = results.length ? Math.round((pass / results.length) * 100) : 0;
console.log(`\n${pass} of ${results.length} — ${rate}%  (effort: ${EFFORT})\n`);

/* The bar is 95%. Below it, the briefing is not doing its job — and the useful
   move is almost always to read the failing answers in the transcript rather
   than to loosen a check here. */
if (rate < 95) {
  console.log('Below the 95% bar. Read the transcript before changing anything:\n' +
    'a case that fails because the model phrased something unexpectedly is a case\n' +
    'to fix; a case that fails because the answer was wrong is the briefing to fix.\n');
}
process.exit(rate >= 95 ? 0 : 1);
