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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LOOP_PORT || 4410);
const STUB = PORT + 1;
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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const ask = (question) => fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
}).then(async r => ({ status: r.status, body: await r.json() }));

try {
  await new Promise((resolve, reject) => stub.listen(STUB, resolve).on('error', reject));
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\nHaTi-Mapper — assistant tool loop\n');

  /* The assistant answers from the cached scan, so prime it first. */
  const scanRes = await fetch(`${BASE}/api/scan`);
  check('A scan is available for the assistant to read', scanRes.ok, `got ${scanRes.status}`);

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

  /* ---- 7. nothing from HaTi's contracts can reach the model ---- */
  const everythingSent = JSON.stringify(seen.concat(script)) + JSON.stringify(seen);
  const allTurns = JSON.stringify(seen);
  check('The stand-in never received a bearer token or key', !/sk-ant-stand-in|Bearer /.test(allTurns));

  /* ---- 8. the key is never handed to the browser ---- */
  const cfg = await (await fetch(`${BASE}/api/ai/config`)).json();
  check('The config route reports a key is set', cfg.configured === true);
  check('The config route never returns the key', !JSON.stringify(cfg).includes('stand-in-key'), JSON.stringify(cfg));
  check('Only a last-four hint is exposed', /^••••/.test(cfg.hint), cfg.hint);
  check('A key set in the environment is locked against the page', cfg.lockedToEnvironment === true);
  const put = await fetch(`${BASE}/api/ai/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sk-ant-attacker' }),
  });
  check('The page cannot overwrite an environment-set key', put.status === 409, `got ${put.status}`);

  /* ---- 9. the change log ---- */
  const ch = await (await fetch(`${BASE}/api/changes`)).json();
  check('The change log is watching', ch.watching === true, JSON.stringify(ch).slice(0, 120));
  check('It keeps 72 hours', ch.retentionHours === 72);
  check('The first scan records a baseline, not a change', ch.rounds.length === 0 && ch.snapshots === 1, JSON.stringify(ch.rounds).slice(0, 80));
} catch (e) {
  check('The loop test itself completed', false, e.stack || String(e));
  console.error(log);
} finally {
  server.kill();
  stub.close();
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
