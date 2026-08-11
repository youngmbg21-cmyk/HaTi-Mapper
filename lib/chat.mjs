/* HaTi-Mapper — the assistant.
 *
 * Same shape as HaTi's own Copilot: a tool loop where the model fetches real
 * data before answering, and finishes by calling deliver_answer exactly once.
 * It can only read what the dashboard already shows — the scan payload, the
 * change log, and the live caps — so it cannot reach HaTi's contracts
 * even in principle.
 *
 * The one thing done differently from HaTi's Copilot: this one is instructed,
 * hard, to talk like a person rather than a developer. The whole point of the
 * dashboard is that a non-developer can understand their own platform, and an
 * assistant that answers in jargon would undo that.
 */

import { MAX_HISTORY_HOURS } from './history.mjs';
import { draftSystem } from './draft.mjs';

/* ------------------------------------------------------------- registers
 *
 * Two ways of saying the same true thing. This is NOT tone and NOT personality
 * — it is what an answer is allowed to LEAVE OUT. Plain leaves out the machine
 * detail; it never leaves out a caveat, a warning or a "this needs a person".
 *
 * Everything below that depends on the register is a FUNCTION taking the
 * register, never a constant computed when this module loads. A constant would
 * freeze whichever register happened to be current on the first request and
 * every later flip would move the button and nothing else. That has happened;
 * it is why the shape of this file is what it is.
 */

export const REGISTERS = ['plain', 'technical'];

export function normalizeRegister(v) {
  return REGISTERS.indexOf(String(v || '').toLowerCase().trim()) >= 0
    ? String(v).toLowerCase().trim()
    : 'plain';
}

/* The chart kinds this dashboard can actually draw. Chosen from what the
   Mapper genuinely measures — there is no deploy log, no test run and no
   request-latency series in this product, so there are no chart kinds for
   them. The client holds the recipe for each of these; this list is what the
   model is allowed to name. test/copilot.mjs pins the two together. */
export const CHART_KINDS = [
  { kind: 'cost-trend', unit: 'US dollars', what: 'what a full day at HaTi\'s caps would cost, one reading per scan that found something different' },
  { kind: 'cost-by-feature', unit: 'US dollars', what: 'estimated cost of a single use, per AI feature' },
  { kind: 'ai-caps', unit: 'requests per 15 minutes', what: 'the usage cap on each AI feature' },
  { kind: 'open-doors-trend', unit: 'addresses', what: 'how many server addresses work without logging in, per reading' },
  { kind: 'scan-health-trend', unit: 'percent', what: 'how much of HaTi the scanner could read, per reading' },
  { kind: 'code-size-trend', unit: 'kilobytes', what: 'the total size of everything scanned, per reading' },
  { kind: 'gaps-trend', unit: 'gaps', what: 'how many known gaps were written down, per reading' },
  { kind: 'changes-per-day', unit: 'changes', what: 'how many changes the Mapper observed on each of the last 14 days' },
  { kind: 'changes-by-area', unit: 'changes', what: 'the changes the Mapper observed, grouped by the part of HaTi they touched' },
  { kind: 'biggest-files', unit: 'kilobytes', what: 'the largest files in HaTi, biggest first' },
  { kind: 'quoted', unit: 'whatever you state', what: 'THE ONE EXCEPTION — figures you supply yourself; see below' },
];

/* The register block. Read at call time, every time. */
export function registerRules(register) {
  const r = normalizeRegister(register);

  if (r === 'technical') {
    return `HOW TO WRITE THIS ANSWER — REGISTER: TECHNICAL
The reader has asked for full engineering depth. Give it to them.
- Use the exact names as they appear in the data: file paths, route addresses with their method, identifiers, model ids, table and column names, commit hashes, the literal text of a warning or a log line.
- Use exact figures and exact timestamps, as they appear. Bytes, kilobytes, counts, percentages, dollar amounts to the precision the data carries, ISO timestamps.
- State your assumptions explicitly, and state what the data does not settle.
- Do not simplify a distinction away. If two numbers count different things, say what each counts rather than reconciling them.
- Do not translate jargon into everyday language here — the reader wants the terms.
- Length follows the material. Structure it with headings, lists and tables where that makes it easier to read.
- You may still be brief if the answer is genuinely brief. Depth is not padding.`;
  }

  return `HOW TO WRITE THIS ANSWER — REGISTER: PLAIN
The reader is not a developer. They build software by describing what they want.
- Lead with the answer in everyday words. Then the reason for it.
- Two or three sentences unless more is genuinely needed. Resist the third paragraph.
- Say what it means for the business, not what the machine did. "The login page has been slow since Tuesday afternoon, and it started right after the last update went out" — not the endpoint and the percentile.
- No jargon unless you say what it means in the same breath: "endpoint (an address the app calls to fetch something)".
- Prefer ordinary-life comparisons — shops, filing cabinets, post — over precise definitions.
- File paths and addresses may appear, but say what the thing DOES first and treat the path as a footnote.

PLAIN IS SHORTER, NEVER LESS ACCURATE.
Never drop a caveat, a warning, a risk or a "this needs a person to look at it" in order to be brief. If something is genuinely uncertain, say so here exactly as you would in the technical register — in plainer words, but say it. A short answer that leaves out the worrying part is the one failure this register must not have.`;
}

/* Sent in BOTH registers. These are what make an answer trustworthy rather
   than merely fluent, and none of them is a matter of style. */
export function groundRules() {
  return `GROUND RULES — BOTH REGISTERS, EVERY ANSWER
- Use the specific figures and timestamps from the data you were given. Never recompute one, never round one into a different claim, and never invent one.
- If a question needs something that is not in the data you can reach, say so plainly instead of guessing. "I can't see that from here" is a good answer and a useful one.
- Distinguish "this is broken" from "this looks unusual", and say which one you mean. They are different claims and only one of them is an emergency.
- Never say something is fixed unless the data shows it recovered. "It has not happened again since 04:00" is a fact; "it is fixed" is a promise you cannot make from here.`;
}

/* The chart contract. The model names a kind; it never supplies the numbers.
   Whatever it emits, the client throws the block away and draws the chart from
   this dashboard's own live records. */
export function chartRules() {
  const list = CHART_KINDS.map(c => `  - ${c.kind} — ${c.what} (unit: ${c.unit})`).join('\n');
  return `CHARTS — YOU NAME ONE, YOU NEVER SUPPLY ITS NUMBERS
You may put at most ONE chart in a reply, by emitting a fenced block exactly like this:

\`\`\`monitor-chart
{ "kind": "cost-trend", "title": "What a day at the caps would cost" }
\`\`\`

The block carries a kind and an optional short title and NOTHING ELSE. No numbers, no labels, no arrays, no dates. The page throws your block away and draws the chart itself, from the same records the dashboard beside it is drawn from. A number you invent can appear in a sentence, where the reader can weigh it. It may never appear in a chart, which the reader reads as measured fact.

The kinds you may name:
${list}

- "quoted" is the single exception: it draws figures YOU supply, and only figures you have already stated in the same reply. Between 2 and 12 plain numbers, all in the same unit. Emit them as { "kind": "quoted", "title": "…", "unit": "…", "points": [{ "label": "Mon", "value": 4 }, …] }. They are labelled on screen as your own figures rather than as measured data. Use it only when what you want to show is genuinely not one of the measured kinds above.
- At most one chart per reply. Pick the single most useful one.
- No chart at all for small talk, definitions, advice, or an answer that is only words. Most replies should have no chart.
- Only the kinds listed above are valid. Anything else draws a visible error card in place of the chart.
- Refer to the chart in your text, so the reader knows why it is there.
- Never mix units in one chart. Milliseconds and counts on one axis is not a chart, it is two charts on top of each other.`;
}

export function chatTools(register) {
  const r = normalizeRegister(register);

  /* The description on deliver_answer's `answer` field is the instruction
     sitting closest to the question, and a specific instruction beats a
     general one in the background briefing every time. So it carries the
     register too, rather than permanently saying "short and plain" and quietly
     overriding the technical register from six inches away. */
  const answerHint = r === 'technical'
    ? 'The answer in markdown, at full engineering depth. Exact names, exact figures, exact timestamps as they appear in the data you fetched. Headings, lists and tables where they help. State your assumptions. Ground every claim in data you fetched.'
    : 'The answer in short, plain markdown, written for someone who does not read code. Lead with the point, then the reason. Two or three sentences unless more is genuinely needed. Never drop a caveat or a warning to be brief. Ground every claim in data you fetched.';

  return [
  {
    name: 'get_overview',
    description: 'The headline state of the platform: how many screens, AI features, models, data tables, doors that need no login, and known gaps; when it was last scanned and which version of the code. Start here for broad questions like "how is it looking" or "what should I worry about".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_panel',
    description: 'The full contents of one section of the dashboard. Use this whenever the user asks about a specific area.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: ['screens', 'ai', 'storage', 'dependencies', 'gaps', 'public', 'commits', 'weight'],
          description: 'screens = every screen and the file it lives in. ai = every feature that calls Anthropic, its model and cost caps. storage = the database tables. dependencies = what breaks what. gaps = what is not finished. public = what works without logging in. commits = the git log — messages someone wrote when they saved work, NOT what the Mapper observed change; never report a count of these as "changes". weight = file sizes and unused names.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_changes',
    description: 'What has actually changed in the platform, from the Mapper\'s own watch log. THIS IS THE ONLY SOURCE FOR A COUNT OF CHANGES. Use for "what changed", "what is new", "has anything moved since yesterday", "has this been growing for a month". It is what the Mapper observed by comparing one scan with the next — not the git log, which is `commits` and is a different number counting a different thing. An empty result means the Mapper has observed nothing, which is a real and reportable answer; it does not mean look somewhere else for a bigger number.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'How far back to look, up to 2160 (90 days). Defaults to 72.' } },
    },
  },
  {
    name: 'search_map',
    description: 'Search everything the Mapper knows — screens, files, AI features, tables, open addresses, gaps, unused names — for a word or phrase. Use when the user names something specific and you are not sure which section it lives in.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A word or phrase, e.g. "signing", "contract.js", "playbook", "obligations".' } },
      required: ['query'],
    },
  },
  {
    name: 'get_launch_readiness',
    description: 'The launch checklist: whether the owner is ready to demo HaTi, ready to let real customers use it, and exactly what is outstanding for each. Use for "am I ready", "can I demo this", "what is left before launch", "what should I do next", "is it safe to go live", and for any question about backups, restoring, rollback or losing work. Each item says who answers it — the Mapper measured it, or the owner ticked it — and items the owner ticked can go stale and stop counting.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_live_usage',
    description: 'The AI usage limits actually in force on the running HaTi right now, and how many AI requests have been made today. Use for questions about spending, limits, or "how much are we using". Returns unavailable if the Mapper cannot reach HaTi.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'deliver_answer',
    description: 'Give the final answer to the user. Call this exactly once, after you have fetched what you need.',
    input_schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: answerHint },
        sources: {
          type: 'array',
          description: 'Which sections of the dashboard this answer came from, so the user can go and look.',
          items: {
            type: 'object',
            properties: {
              panel: { type: 'string', enum: ['screens', 'cost', 'data', 'blast', 'gaps', 'public', 'changes', 'weight', 'launch'], description: 'The dashboard tab that shows this.' },
              note: { type: 'string', description: 'Optional: what to look at there.' },
            },
            required: ['panel'],
          },
        },
        watch_out: {
          type: 'string',
          description: 'Optional. One sentence, only when the data genuinely warrants caution — a cost risk, an open door, something already signed that could break. Leave empty otherwise; do not manufacture alarm. This is carried in BOTH registers: a plain answer never drops it to be shorter.',
        },
      },
      required: ['answer'],
    },
  },
  ];
}

/* The tab each panel name maps to, used to turn a source into a real link. */
/* The tab a source opens, which is not always a tab of its own: "Not finished"
   is a card on the Changes tab, and naming a `gaps` tab here produced a source
   chip that looked clickable and did nothing. */
const PANEL_TAB = {
  screens: 'screens', cost: 'cost', data: 'data', blast: 'blast',
  gaps: 'changes', public: 'public', changes: 'changes', weight: 'weight',
  launch: 'launch',
};

const PANEL_LABEL = {
  screens: 'Screens', cost: 'Where the money goes', data: 'Where things are kept',
  blast: 'What breaks what', gaps: 'Not finished', public: 'Open to the public',
  changes: 'What changed', weight: 'Getting bulky', launch: 'Ready to launch?',
};

/* ------------------------------------------------------------ the prompt */

export function buildSystem({ scan, historyStatus, pulse, draft, register, restate }) {
  const s = scan || {};
  const reg = normalizeRegister(register);
  const counts = {
    screens: (s.screens || []).length,
    features: (s.ai?.features || []).length,
    models: (s.ai?.modelsInUse || []).length,
    tables: (s.storage?.tables || []).length,
    open: (s.public?.routes || []).length,
    gaps: (s.gaps?.gaps || []).length,
    bulky: s.weight?.overThreshold ?? 0,
    orphans: (s.weight?.orphans || []).length,
  };

  const stale = s.scannedAt ? (Date.now() - new Date(s.scannedAt).getTime()) > 24 * 60 * 60 * 1000 : false;

  return `You are the HaTi Platform Map assistant. You help the owner of HaTi — a contract lifecycle management platform for the Kenyan market — understand their own product: what is in it, what it costs to run, what depends on what, and what has been changing.

WHO YOU ARE TALKING TO
The person reading your answers is the owner of this business. They are experienced and sharp, but they are NOT a developer. They build software by describing what they want. They choose, with a toggle above the input box, how much machine detail they want back. That choice is the register below, and it is theirs, not yours to override.

${registerRules(reg)}

${groundRules()}

${chartRules()}

HOW TO WORK
- Fetch before you answer. Use the tools to get real data; never state a number, name, file or finding you have not fetched. If the data does not cover it, say so plainly — a visible gap is more useful than a confident guess.
- For "what changed" or "what's new", use get_changes — that is the Mapper's own watch log, in plain terms, and it can look back up to 90 days. The "commits" panel is the raw git history and is usually the less useful answer.
- For anything about cost, limits or spending, call get_live_usage as well as the ai panel, so you can separate what the code allows from what is actually set on the live system.
- Finish by calling deliver_answer exactly once, and point at the dashboard tabs where they can see it for themselves.

WHAT YOU KNOW AND DO NOT KNOW
You can see how HaTi is BUILT. You cannot see anything IN it. No contracts, no counterparties, no names, no email addresses, no money figures, no customer data of any kind reaches you — by design, so this assistant can never become a way to read the contracts HaTi is holding. If asked about a specific contract, a client, or a value, say plainly that you can see the machinery but never the paperwork, and that they should look in HaTi itself.

SCOPE
- You explain and suggest. You do not change anything, and you cannot — you have no way to edit code or settings.
- You are not a lawyer and this is not legal advice.
- Be honest about risk without being alarmist. If something is genuinely worth attention — a paid feature nobody calls, a new door with no login, a hand-written map gone stale — say so once, clearly, and say what it would take to deal with it.

CURRENT STATE (already fetched for you — no tool call needed for these headline numbers)
- ${counts.screens} screens, ${counts.features} features that call Anthropic across ${counts.models} model${counts.models === 1 ? '' : 's'}, ${counts.tables} database tables.
- ${counts.open} server addresses work without logging in, and ${counts.gaps} known gaps are written down.
- ${counts.bulky} files are over the 60 KB "getting hard to work on" line, and ${counts.orphans} published names are never used anywhere.
- Last scanned: ${s.scannedAt || 'unknown'}${stale ? ' — that is over a day old, so mention it may not reflect the newest code' : ''}. Code version: ${s.commit || 'unknown'}.
- Change log: ${historyStatus?.watching ? `watching since ${historyStatus.since}, ${historyStatus.changeCount} change${historyStatus.changeCount === 1 ? '' : 's'} recorded in the last 72 hours` : 'just started — nothing recorded yet'}.
- Money headline: ${s.cost?.dailyMixedUsd != null ? `the dashboard's "Today's burn" figure is $${Number(s.cost.dailyMixedUsd).toFixed(2)} (worst case $${Number(s.cost.dailyCeilingUsd ?? 0).toFixed(2)})` : 'no money figure could be estimated this scan'}.

THE MONEY FIGURES ARE THIS DASHBOARD'S OWN ESTIMATES.
The dollar amounts on the "Today's burn" tile and the Money panel are computed
BY THE MAPPER: the request caps written in HaTi's code multiplied by the prices
in data/pricing.js, priced pessimistically. They are a ceiling on what a whole
day COULD cost — "a roof, not a bill". They are not live spend, not an invoice,
and not data from inside HaTi; no dollar figure ever crosses from the running
site. If asked about a dollar amount shown on the dashboard, explain it as this
estimate (get_panel "ai" carries the breakdown under moneyEstimates) — never
speculate that it is real billing data, and never disown a number the dashboard
itself is displaying.

TWO DIFFERENT THINGS ARE CALLED "CHANGES". DO NOT MIX THEM UP.
- The CHANGE LOG is what the Mapper observed by comparing one of its own scans
  with the next: a door opened, a file grew, a gap closed. It is what the
  dashboard's calendar counts and what "what changed" means. Only get_changes
  gives you this.
- COMMITS are the git log — the messages someone typed when saving work. They
  are a different number, counting a different thing, and having twelve of them
  says nothing about whether the Mapper observed anything move.
If the change log is empty, say so plainly: the Mapper has not observed
anything change. It needs at least two scans to compare, so a freshly started
or freshly restarted Mapper legitimately has nothing. Do not reach for the
commit count to fill that gap, do not describe commits as changes, and never
tell the user a figure on the dashboard is wrong because a commit count differs
from it — that is two correct numbers measuring different things.
- Live HaTi: ${pulse?.available ? 'reachable, so live usage figures are available' : 'not reachable right now, so only the code defaults are available'}.
${(s.warnings || []).length ? `\nTHINGS THE SCAN ITSELF COULD NOT WORK OUT (mention if relevant, do not hide them):\n${(s.warnings || []).slice(0, 6).map(w => '- ' + w).join('\n')}` : ''}${restate ? '\n' + RESTATE_SYSTEM : ''}${draft ? '\n' + draftSystem(reg) : ''}`;
}

/* What the system prompt gains when the owner flips the toggle over an answer
   that is already on screen. It is the same answer in the other register —
   one explanation wearing two registers is one thing, so it must not become a
   second opinion. */
const RESTATE_SYSTEM = `
YOU ARE RESTATING AN ANSWER YOU ALREADY GAVE, NOT ANSWERING AGAIN
The owner has flipped the register toggle over an answer already on their screen. Say the SAME thing in the register described above.

- Same findings, same conclusion, same figures. If the previous answer said the change log is empty, this one says the change log is empty.
- Nothing may be lost going into the plainer register: every caveat, every warning, every uncertainty, every "someone should look at this" survives, in plainer words.
- Nothing may be gained going into the more technical register either. If you need an exact figure the previous answer did not carry, FETCH it with the tools — do not reconstruct it from memory and do not estimate it.
- Do not open by mentioning the toggle, the register, or that you are restating. Just give the answer.
- Deliver it with deliver_answer exactly once, with the same watch_out if one applied.`;

/* ------------------------------------------------------------- the tools */

export function runTool(name, input, ctx) {
  const { scan, history, pulse } = ctx;
  const s = scan || {};
  const a = input || {};

  switch (name) {
    case 'get_overview':
      return {
        scannedAt: s.scannedAt, codeVersion: s.commit, repository: s.repo,
        screens: (s.screens || []).length,
        aiFeatures: (s.ai?.features || []).length,
        modelsInUse: s.ai?.modelsInUse || [],
        dataTables: (s.storage?.tables || []).length,
        addressesWithNoLogin: (s.public?.routes || []).length,
        linkTypesWithNoLogin: (s.public?.hashes || []).map(h => h.hash),
        knownGaps: (s.gaps?.gaps || []).length,
        filesOverTheLine: s.weight?.overThreshold ?? null,
        unusedPublishedNames: (s.weight?.orphans || []).length,
        handWrittenMapWarnings: s.dependencies?.warnings || [],
        thingsTheScanCouldNotWorkOut: s.warnings || [],
        changeLog: history ? history.status() : null,
      };

    case 'get_panel': {
      switch (a.name) {
        case 'screens':
          return {
            screens: (s.screens || []).map(x => ({
              name: x.label, whatAPersonDoesHere: x.does || 'not detected',
              file: x.module, sizeKB: x.bytes ? Math.round(x.bytes / 1024) : null,
              reachedBy: x.entry === 'hash' ? 'a link, no login needed' : 'the main menu',
              sharesItsFileWith: x.sharedWith || [],
            })),
            valueStreams: (s.streams || []).map(x => x.name),
            noteOnValueStreams: s.customStreamsNote,
            filesDoingSeveralJobs: (s.moduleFacts || []).filter(m => m.multiJob || m.multiScreen)
              .map(m => ({ file: m.module, sizeKB: Math.round(m.bytes / 1024), separateJobsInside: m.sections, screensItPowers: m.screens, publishedNames: m.exportCount })),
          };

        case 'ai':
          /* The money estimates ride along with the features. They are the
             dashboard's own headline — "Today's burn", the Money panel — and
             leaving them out of this tool taught the assistant that no dollar
             figure existed, at which point it guessed, and guessed that the
             number was live business data from inside HaTi. It is the
             opposite: an estimate this dashboard computes from the caps in
             HaTi's code and the prices in data/pricing.js. */
          return {
            features: (s.ai?.features || []).map(f => {
              const priced = (s.cost?.features || []).find(c => c.feature === f.feature);
              return {
                name: f.label || f.feature, whatItDoes: f.does || 'not detected',
                address: f.route, costTier: f.tiers, model: f.models,
                capPer15Minutes: f.cap, usedByScreens: f.usedBy?.map(u => (u.via?.length ? u.via : [u.module])).flat() || [],
                calledFromTheApp: (f.usedBy || []).length > 0,
                estimatedUsdPerUse: priced?.perRequestUsd ?? null,
              };
            }),
            limitsWrittenInTheCode: s.ai?.caps || [],
            routesUnderAiThatCostNothing: s.ai?.nonBillingAiRoutes || [],
            moneyEstimates: s.cost ? {
              whatTheseAre: 'Estimates this dashboard computes itself — the caps in HaTi\'s code multiplied by the prices in data/pricing.js. They are NOT live spend, NOT a bill, and NOT read from inside HaTi. The dashboard\'s "Today\'s burn" headline is dailyRealisticUsd.',
              dailyRealisticUsd: s.cost.dailyMixedUsd,
              dailyWorstCaseUsd: s.cost.dailyCeilingUsd,
              dailyRequestLimit: s.cost.dailyLimit,
              dearestFeature: s.cost.dearest,
              pricingAssumption: s.cost.assumption,
              pricesLastChecked: s.cost.asOf,
              pricesAreStale: !!s.cost.stale,
            } : null,
          };

        case 'storage':
          return {
            tables: (s.storage?.tables || []).map(t => ({ name: t.name, columns: t.columns })),
            thingsStoredInsideOneBlob: s.storage?.blobs || [],
            settingsKeys: s.storage?.settingKeys || [],
          };

        case 'dependencies':
          return {
            note: 'These relationships are hand-written by the developer, not read from the code, because they are judgements about meaning. The scan checks that everything named still exists.',
            items: (s.dependencies?.items || []).map(i => ({
              thing: i.label, storedAs: i.fields,
              partsThatReadIt: (i.reads || []).map(id => (s.dependencies?.subsystems || []).find(x => x.id === id)?.title || id),
              partsThatCouldBreakSomethingAlreadySigned: (i.risk || []).map(id => (s.dependencies?.subsystems || []).find(x => x.id === id)?.title || id),
              explanation: String(i.note || '').replace(/<[^>]+>/g, ''),
            })),
            outOfDateWarnings: s.dependencies?.warnings || [],
          };

        case 'gaps':
          return {
            note: s.gaps?.markerNote || null,
            gaps: (s.gaps?.gaps || []).map(g => ({ what: g.title, detail: g.detail, whereItIsWrittenDown: g.source, severityStatedBySource: g.severity || 'none stated' })),
          };

        case 'public':
          return {
            linkTypesThatNeedNoLogin: (s.public?.hashes || []).map(h => ({ link: h.hash, what: h.label, detail: h.detail })),
            addressesThatNeedNoLogin: (s.public?.routes || []).map(r => ({
              address: `${r.method} ${r.path}`,
              guardedBy: [
                r.servesShell ? 'it only serves the app page, no data' : null,
                r.tokenGuarded ? 'it checks its own secret in the handler' : null,
                r.tokenInPath ? 'it needs an unguessable code in the link' : null,
                r.middleware?.length ? `rate limited (${r.middleware.join(', ')})` : null,
              ].filter(Boolean),
            })),
            totalServerAddresses: s.public?.totalRoutes,
          };

        case 'commits':
          return {
            note: 'The git log: messages someone wrote when saving work. These are NOT changes the Mapper observed, and their count is not a change count — reporting it as one contradicts the dashboard. For what actually moved, use get_changes.',
            commitCountIsNotAChangeCount: true,
            commits: (s.changes || []).map(c => ({ when: c.date, what: c.subject, areasTouched: c.areas, fileCount: c.fileCount })),
          };

        case 'weight':
          return {
            theLine: '60 KB — past this a file gets hard to work on',
            filesOverTheLine: (s.weight?.files || []).filter(f => f.bytes > (s.weight?.threshold || 61440)).map(f => ({ file: f.path, sizeKB: Math.round(f.bytes / 1024) })),
            allFiles: (s.weight?.files || []).map(f => ({ file: f.path, sizeKB: Math.round(f.bytes / 1024) })),
            publishedButNeverUsed: s.weight?.orphans || [],
            totalPublishedNames: s.weight?.exportCount,
          };

        default:
          return { error: `There is no section called "${a.name}".` };
      }
    }

    case 'get_changes': {
      if (!history) return { error: 'The change log is not available.' };
      const hours = Math.min(Math.max(Number(a.hours) || 72, 1), MAX_HISTORY_HOURS);
      const rounds = history.changes(hours);
      return {
        window: `the last ${hours} hours`,
        status: history.status(),
        changes: rounds.map(r => ({ noticedAt: r.at, codeVersion: r.commit, what: r.events.map(e => e.text) })),
        nothingChanged: rounds.length === 0,
      };
    }

    case 'search_map': {
      const q = String(a.query || '').toLowerCase().trim();
      if (!q) return { error: 'Give me something to look for.' };
      const hit = (t) => String(t || '').toLowerCase().includes(q);
      return {
        query: a.query,
        screens: (s.screens || []).filter(x => hit(x.label) || hit(x.module) || hit(x.does)).map(x => ({ name: x.label, file: x.module, does: x.does })),
        aiFeatures: (s.ai?.features || []).filter(f => hit(f.label) || hit(f.route) || hit(f.does)).map(f => ({ name: f.label, address: f.route, does: f.does, model: f.models })),
        tables: (s.storage?.tables || []).filter(t => hit(t.name) || (t.columns || []).some(hit)).map(t => ({ name: t.name, columns: t.columns })),
        addressesWithNoLogin: (s.public?.routes || []).filter(r => hit(r.path)).map(r => `${r.method} ${r.path}`),
        gaps: (s.gaps?.gaps || []).filter(g => hit(g.title) || hit(g.detail)).map(g => ({ what: g.title, where: g.source })),
        files: (s.weight?.files || []).filter(f => hit(f.path)).map(f => ({ file: f.path, sizeKB: Math.round(f.bytes / 1024) })),
        unusedNames: (s.weight?.orphans || []).filter(o => hit(o.name) || hit(o.exportedFrom)),
        dependencyItems: (s.dependencies?.items || []).filter(i => hit(i.label) || (i.fields || []).some(hit)).map(i => i.label),
        partsOfThePlatform: (s.dependencies?.subsystems || []).filter(x => hit(x.title) || hit(x.desc) || hit(x.file))
          .map(x => ({ part: x.title, what: x.desc, file: x.file })),
      };
    }

    case 'get_launch_readiness': {
      if (!ctx.launch) return { available: false, why: 'The readiness checklist could not be worked out on this request.' };
      const L = ctx.launch;
      return {
        verdict: L.verdict === 'not-demo' ? 'not ready to demo yet'
          : L.verdict === 'demo' ? 'ready to demo, not ready for real customers'
            : 'ready to go live',
        inOneSentence: L.headline,
        needlePosition: L.needle,
        itemsDone: L.counts.done,
        itemsTotal: L.counts.total,
        blockingADemo: L.counts.demoOpen,
        blockingGoingLive: L.counts.liveOpen,
        itemsTheMapperCannotTell: L.counts.cantTell,
        ticksThatHaveGoneStale: L.counts.stale,
        /* The whole list, because "what is left" is the question this tool
           exists for and a summary would send the model back for the rest. */
        outstanding: L.items.filter(i => !i.done).map(i => ({
          title: i.title,
          blocks: i.gate === 'demo' ? 'the demo and the launch' : i.gate === 'live' ? 'the launch' : 'neither — worth having anyway',
          answeredBy: i.how === 'mapper' ? 'the Mapper measured this' : 'the owner ticks this',
          state: i.state === 'unknown' ? 'the Mapper cannot tell' : i.state === 'stale' ? 'ticked too long ago to still count' : 'not done',
          whyItMatters: i.why,
          where: i.detail,
          howToDoIt: i.steps || null,
        })),
        alreadyDone: L.items.filter(i => i.done).map(i => i.title),
      };
    }

    case 'get_live_usage':
      if (!pulse || !pulse.available) {
        return { available: false, why: pulse?.reason || 'The Mapper could not reach the running HaTi.', note: 'Only the limits written in the code are available. Use get_panel with "ai" for those.' };
      }
      return {
        available: true,
        limitsInForceRightNow: pulse.caps,
        aiRequestsToday: pulse.usage,
        anAiKeyIsConfigured: pulse.aiKeyConfigured,
        runningVersion: pulse.version,
        readAt: pulse.fetchedAt,
      };

    default:
      return { error: `No such tool: ${name}` };
  }
}

/* Tidy the model's final answer into exactly the shape the page renders. */
export function normalizeAnswer(input) {
  const inp = input || {};
  const answer = typeof inp.answer === 'string' && inp.answer.trim()
    ? inp.answer.trim()
    : 'I could not put an answer together for that one.';
  const sources = (Array.isArray(inp.sources) ? inp.sources : [])
    .filter(x => x && PANEL_TAB[x.panel])
    .map(x => ({ panel: x.panel, tab: PANEL_TAB[x.panel], label: PANEL_LABEL[x.panel], note: typeof x.note === 'string' ? x.note.slice(0, 200) : '' }))
    .filter((x, i, arr) => arr.findIndex(y => y.panel === x.panel) === i)
    .slice(0, 4);
  const watchOut = typeof inp.watch_out === 'string' && inp.watch_out.trim() ? inp.watch_out.trim().slice(0, 400) : null;
  return { answer, sources, watchOut };
}

export { PANEL_LABEL };
