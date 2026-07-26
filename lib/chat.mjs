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
import { DRAFT_SYSTEM } from './draft.mjs';

export const CHAT_TOOLS = [
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
          description: 'screens = every screen and the file it lives in. ai = every feature that calls Anthropic, its model and cost caps. storage = the database tables. dependencies = what breaks what. gaps = what is not finished. public = what works without logging in. commits = recent git history. weight = file sizes and unused names.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_changes',
    description: 'What has actually changed in the platform, from the Mapper\'s own watch log. Use for "what changed", "what is new", "has anything moved since yesterday", "has this been growing for a month". This is different from `commits` — it is what the Mapper noticed, in plain terms, not the git log.',
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
        answer: {
          type: 'string',
          description: 'The answer in short, plain markdown, written for someone who does not read code. Lead with the point. Ground every claim in data you fetched.',
        },
        sources: {
          type: 'array',
          description: 'Which sections of the dashboard this answer came from, so the user can go and look.',
          items: {
            type: 'object',
            properties: {
              panel: { type: 'string', enum: ['screens', 'cost', 'data', 'blast', 'gaps', 'public', 'changes', 'weight'], description: 'The dashboard tab that shows this.' },
              note: { type: 'string', description: 'Optional: what to look at there.' },
            },
            required: ['panel'],
          },
        },
        watch_out: {
          type: 'string',
          description: 'Optional. One sentence, only when the data genuinely warrants caution — a cost risk, an open door, something already signed that could break. Leave empty otherwise; do not manufacture alarm.',
        },
      },
      required: ['answer'],
    },
  },
];

/* The tab each panel name maps to, used to turn a source into a real link. */
const PANEL_TAB = {
  screens: 'screens', cost: 'cost', data: 'data', blast: 'blast',
  gaps: 'gaps', public: 'public', changes: 'changes', weight: 'weight',
};

const PANEL_LABEL = {
  screens: 'Screens', cost: 'Where the money goes', data: 'Where things are kept',
  blast: 'What breaks what', gaps: 'Not finished', public: 'Open to the public',
  changes: 'What changed', weight: 'Getting bulky',
};

/* ------------------------------------------------------------ the prompt */

export function buildSystem({ scan, historyStatus, pulse, draft }) {
  const s = scan || {};
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
The person reading your answers is the owner of this business. They are experienced and sharp, but they are NOT a developer. They build software by describing what they want. They should never have to decode jargon to understand you.

HOW TO WRITE — this matters more than anything else here:
- Lead with the answer in everyday words. Then the detail.
- Translate any technical term the moment you use it: "endpoint (an address the app calls to fetch something)", "repository (the folder on GitHub where the code lives)".
- Prefer analogies from ordinary life — shops, filing cabinets, kitchens, post — over precise definitions.
- Say why something matters, not just what it is. "views/contract.js is 159 KB" means nothing on its own; "one file is doing four jobs, which makes every change to documents slower and riskier" is the answer.
- Short sentences. Never stack jargon.
- File paths and route addresses are fine to mention, but always say what the thing DOES first and treat the path as a footnote.
- Never say "the codebase", "refactor", "middleware", "payload" or "schema" without explaining them in the same breath.

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
- Live HaTi: ${pulse?.available ? 'reachable, so live usage figures are available' : 'not reachable right now, so only the code defaults are available'}.
${(s.warnings || []).length ? `\nTHINGS THE SCAN ITSELF COULD NOT WORK OUT (mention if relevant, do not hide them):\n${(s.warnings || []).slice(0, 6).map(w => '- ' + w).join('\n')}` : ''}${draft ? '\n' + DRAFT_SYSTEM : ''}`;
}

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
          return {
            features: (s.ai?.features || []).map(f => ({
              name: f.label || f.feature, whatItDoes: f.does || 'not detected',
              address: f.route, costTier: f.tiers, model: f.models,
              capPer15Minutes: f.cap, usedByScreens: f.usedBy?.map(u => (u.via?.length ? u.via : [u.module])).flat() || [],
              calledFromTheApp: (f.usedBy || []).length > 0,
            })),
            limitsWrittenInTheCode: s.ai?.caps || [],
            routesUnderAiThatCostNothing: s.ai?.nonBillingAiRoutes || [],
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
          return { note: 'This is the raw git history. For what actually changed in plain terms, use get_changes instead.', commits: (s.changes || []).map(c => ({ when: c.date, what: c.subject, areasTouched: c.areas, fileCount: c.fileCount })) };

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
