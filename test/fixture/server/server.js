/* HaTi server - one Express service over one SQLite file. */

const express = require("express");
const app = express();
const INDEX = __dirname + "/../index.html";

const AI_WINDOW_MS = 15 * 60 * 1000;

const AI_TIER_DEFAULTS = {
  fast: 'claude-haiku-4-5-20251001',
  deep: 'claude-sonnet-5',
};

const AI_FEATURE_LABEL = {
  template_convert: 'Document converter',
  search: 'Register question',
  graph: 'Contract graph',
  extract: 'Detail extraction',
  template: 'Template match',
  playbook: 'Clause review',
  obligations: 'Obligation finder',
  ocr: 'Scanned page reader',
  blanks: 'Blank finder',
  chat: 'The Copilot',
};

/* ---------------------------------------------------------- the caps */

const rlAiLight = rateLimit('ai-light', () => intSetting('aiRateLight', 'AI_RATE_LIGHT', 40), AI_WINDOW_MS);
const rlAiDeep = rateLimit('ai-deep', () => intSetting('aiRateDeep', 'AI_RATE_DEEP', 12), AI_WINDOW_MS);
const rlAiOcr = rateLimit('ai-ocr', () => intSetting('aiRateOcr', 'AI_RATE_OCR', 400), AI_WINDOW_MS);

const dailyLimit = () => intSetting('aiDailyLimit', 'AI_DAILY_LIMIT', 500);
const maxChars = () => intSetting('aiMaxChars', 'AI_MAX_CHARS', 50000);
const maxContracts = () => intSetting('aiMaxContracts', 'AI_MAX_CONTRACTS', 40);

/* ------------------------------------------------------------ storage */

db.exec("CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, json TEXT, name TEXT, counterparty TEXT, folder TEXT, status TEXT, value REAL, expiry TEXT, is_upload INTEGER, seq INTEGER, version INTEGER, updated_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, data BLOB, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, description TEXT, category TEXT, status TEXT, origin TEXT, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS template_versions (id TEXT PRIMARY KEY, template_id TEXT, version_number INTEGER, status TEXT, published_at TEXT, change_note TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS template_blocks (id TEXT PRIMARY KEY, template_version_id TEXT, order_index INTEGER, block_type TEXT, content TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS template_fields (id TEXT PRIMARY KEY, template_version_id TEXT, field_key TEXT, label TEXT, field_type TEXT, required INTEGER, human_reviewed INTEGER);");
db.exec("CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, payload TEXT, response TEXT, applied INTEGER, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS share_responses (id INTEGER PRIMARY KEY, token TEXT, response TEXT, at TEXT, applied INTEGER);");
db.exec("CREATE TABLE IF NOT EXISTS share_payload_history (id INTEGER PRIMARY KEY, token TEXT, at TEXT, doc_text TEXT, opened_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS share_messages (id INTEGER PRIMARY KEY, contract_id TEXT, token TEXT, side TEXT, author TEXT, topic TEXT, body TEXT, at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS share_otp (token TEXT PRIMARY KEY, email TEXT, code_hash TEXT, verify TEXT, verified INTEGER, expires INTEGER);");
db.exec("CREATE TABLE IF NOT EXISTS engagement (id INTEGER PRIMARY KEY, contract_id TEXT, token TEXT, kind TEXT, at TEXT, ip TEXT, ua TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS activation (id INTEGER PRIMARY KEY, event TEXT, contract_id TEXT, actor TEXT, at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, salt TEXT, hash TEXT, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS resets (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, expires INTEGER, used INTEGER);");
db.exec("CREATE TABLE IF NOT EXISTS advice_requests (id TEXT PRIMARY KEY, json TEXT, token TEXT, service TEXT, status TEXT, email TEXT, created_at TEXT, seq INTEGER);");
db.exec("CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, started_at TEXT, started_by TEXT, finished_at TEXT, status TEXT, rows_json TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, to_addr TEXT, subject TEXT, body TEXT, sent INTEGER, provider TEXT, dev_hint TEXT, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS reminders (rkey TEXT PRIMARY KEY, created_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS copilot_log (id INTEGER PRIMARY KEY, at TEXT, org_id TEXT, user_id TEXT, user_email TEXT, question TEXT, answer TEXT, cited_ids TEXT, model TEXT, steps INTEGER);");
db.exec("CREATE TABLE IF NOT EXISTS ai_spend (day TEXT, feature TEXT, requests INTEGER, calls INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost REAL);");
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, json TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS org_branding (org_id TEXT PRIMARY KEY, logo_url TEXT, company_name TEXT, registration_number TEXT, address TEXT, default_footer_text TEXT, updated_at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS org_profile_values (org_id TEXT, field_key TEXT, value TEXT, updated_at TEXT);");

function saveTemplates(list) {
  if (!Array.isArray(list)) throw new Error("customTemplates must be an array");
  const s = getSetting("appSettings") || {};
  setSetting('appSettings', { ...s, customTemplates: list });
}

function saveApprovalRules(rules) {
  setSetting('approvalRules', rules);
}

function saveClauseLibrary(clauses) {
  setSetting('clauseLibrary', clauses);
}

function saveSignerPlan(plan) {
  setSetting('signerPlan', plan);
}

function savePlaybook(playbook) {
  setSetting('playbook', playbook);
}

/* ------------------------------------------------------- open routes */

app.get('/', (req, res) => {
  res.sendFile(INDEX);
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/status', rlStatus, (req, res) => {
  res.json({ signedIn: !!sessionFor(req), lastView: "dashboard" });
});

app.get('/api/pulse', rlPulse, (req, res) => {
  const presented = req.headers.authorization || "";
  if (!presented.endsWith(MAPPER_TOKEN)) return res.status(401).json({ error: "no" });
  res.json({ caps: caps(), usage: usage(), version: COMMIT });
});

app.get('/api/share/:token', rlShare, (req, res) => {
  const row = shareFor(req.params.token);
  if (!row) return res.status(404).json({ error: "That link has expired." });
  res.json(row);
});

app.get('/api/advice/rates', rlAdvice, (req, res) => {
  res.json(rateCard());
});

app.post('/api/advice/request', rlAdvice, (req, res) => {
  res.json({ id: createAdviceRequest(req.body) });
});

app.post('/api/share/:token/sign', rlShare, (req, res) => {
  res.json({ signed: recordSignature(req.params.token, req.body) });
});

/* ----------------------------------------------------- guarded routes */

app.get('/api/contracts', auth, rlRead, (req, res) => {
  res.json(listContracts());
});

app.put('/api/settings', auth, rlWrite, (req, res) => {
  setSetting('appSettings', req.body);
  res.json({ ok: true });
});

app.put('/api/settings/templates', auth, rlWrite, (req, res) => {
  saveTemplates(req.body.customTemplates);
  res.json({ ok: true });
});

app.get('/api/ai/config', auth, rlRead, (req, res) => {
  res.json({ configured: !!aiKey(), dailyLimit: dailyLimit() });
});

app.put('/api/ai/config', auth, rlWrite, (req, res) => {
  saveAiKey(req.body.key);
  res.json({ ok: true });
});

/* ---------------------------------------------------- the AI features */

app.post('/api/ai/search', auth, rlAiLight, aiFeature('search'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'fast', { max_tokens: 900, messages: req.body.messages });
  res.json(out);
});

app.post('/api/ai/graph', auth, rlAiDeep, aiFeature('graph'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'deep', { max_tokens: 2200, messages: req.body.messages });
  res.json(out);
});

app.post('/api/ai/extract', auth, rlAiLight, aiFeature('extract'), async (req, res) => {
  const key = aiKey();
  const deep = req.body.deep === true;
  const tier = deep ? 'deep' : 'fast';
  const out = await anthropicMessages(key, tier, { max_tokens: 1400, messages: req.body.messages });
  res.json(out);
});

app.post('/api/ai/template', auth, rlAiLight, aiFeature('template'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'fast', { max_tokens: 700, messages: req.body.messages });
  res.json(out);
});

/* Reached through a helper rather than called in the handler, and the helper
   takes a destructured parameter. Both are shapes the real HaTi uses, and the
   scanner used to read neither: the route came back as costing nothing. */
async function aiPlaybookVerdicts(key, { text, kind }) {
  return anthropicMessages(key, 'deep', { max_tokens: 3000, messages: [{ role: 'user', content: text + kind }] });
}

app.post('/api/ai/playbook', auth, rlAiDeep, aiFeature('playbook'), async (req, res) => {
  const key = aiKey();
  const out = await aiPlaybookVerdicts(key, { text: req.body.text, kind: req.body.kind });
  res.json(out);
});

app.post('/api/ai/obligations', auth, rlAiLight, aiFeature('obligations'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'fast', { max_tokens: 1200, messages: req.body.messages });
  res.json(out);
});

app.post('/api/ai/ocr', auth, rlAiOcr, aiFeature('ocr'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'fast', { max_tokens: 1800, messages: req.body.messages });
  res.json(out);
});

app.post('/api/ai/blanks', auth, rlAiLight, aiFeature('blanks'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'fast', { max_tokens: 800, messages: req.body.messages });
  res.json(out);
});

app.post('/api/ai/chat', auth, rlAiDeep, aiFeature('chat'), async (req, res) => {
  const key = aiKey();
  // The tier is chosen in the call itself, not assigned above it.
  const out = await anthropicMessages(key, req.body.compared ? 'deep' : 'fast', { max_tokens: 1600, messages: req.body.messages });
  res.json(out);
});

/* An admin read of the Copilot history. It sits under /api/ai/ and calls
   nothing, so it must not be counted as a paid feature. */
app.get('/api/ai/log', auth, rlRead, (req, res) => {
  res.json({ entries: recentCopilotTurns() });
});

/* A paid endpoint that does NOT sit under /api/ai/. HaTi bills document
   conversion this way, and a scanner filtering on the path prefix misses it
   entirely — the day's ceiling comes out short by its share. */
app.post('/api/templates/upload', auth, rlAiDeep, aiFeature('template_convert'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'deep', { max_tokens: 8192, messages: req.body.messages });
  res.json(out);
});

function runReminders() {
  // Renewal reminders at 90, 60 and 30 days.
  return listContracts().filter(c => noticeDue(c.expiry));
}

module.exports = { app, runReminders, saveTemplates, saveApprovalRules, saveClauseLibrary, saveSignerPlan, savePlaybook };
