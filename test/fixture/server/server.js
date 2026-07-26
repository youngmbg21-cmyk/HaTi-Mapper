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

db.exec("CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, title TEXT, counterparty TEXT, expiry TEXT, value REAL, stage TEXT, redlineText TEXT, docBodyHtml TEXT, fileHash TEXT, dataUrl TEXT, createdAt TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, contractId TEXT, body TEXT, sealString TEXT, createdAt TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, contractId TEXT, expiresAt TEXT, respondedAt TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, contractId TEXT, actor TEXT, what TEXT, at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, contractId TEXT, body TEXT, at TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS obligations (id INTEGER PRIMARY KEY, contractId TEXT, kind TEXT, due TEXT, amountNote TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT, body TEXT, blanks TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, role TEXT, salt TEXT, hash TEXT);");
db.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT, expires INTEGER);");

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

app.post('/api/ai/playbook', auth, rlAiDeep, aiFeature('playbook'), async (req, res) => {
  const key = aiKey();
  const out = await anthropicMessages(key, 'deep', { max_tokens: 3000, messages: req.body.messages });
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
  const out = await anthropicMessages(key, 'deep', { max_tokens: 1600, messages: req.body.messages });
  res.json(out);
});

function runReminders() {
  // Renewal reminders at 90, 60 and 30 days.
  return listContracts().filter(c => noticeDue(c.expiry));
}

module.exports = { app, runReminders, saveTemplates, saveApprovalRules, saveClauseLibrary, saveSignerPlan, savePlaybook };
