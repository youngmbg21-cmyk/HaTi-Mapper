/* HaTi-Mapper — the scanner.
 *
 * Everything here reads HaTi's own source, unpacked from a single repository
 * tarball, and turns it into the seven code-derived panels the dashboard
 * draws. Nothing in this file talks to a running HaTi and nothing in it
 * touches contract data — it only ever sees the source code of the product.
 *
 * The rule throughout: where something cannot be derived reliably, say so.
 * Every panel can return `notDetected` entries and every derived list can come
 * back empty with a reason. A visible gap is more useful than a confident
 * wrong answer.
 */

import { DEPENDENCIES } from '../data/dependencies.js';
import { SCREEN_COPY, FEATURE_COPY, HASH_COPY } from '../data/copy.js';

/* ------------------------------------------------------------------ utils */

const NOT_DETECTED = 'not detected';

const text = (files, path) => {
  const buf = files.get(path);
  return buf ? buf.toString('utf8') : null;
};

const sizeOf = (files, path) => (files.get(path) ? files.get(path).length : null);

/* Source files we consider "the codebase" for cross-referencing. */
const isSource = p =>
  (p.startsWith('js/') || p.startsWith('server/') || p === 'index.html') &&
  (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.html'));

const sourcePaths = files => [...files.keys()].filter(isSource).sort();

/* Count whole-word occurrences of an identifier. */
function wordCount(haystack, word) {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const m = haystack.match(re);
  return m ? m.length : 0;
}

/* The body of a top-level `function name(...) { ... }`, by brace matching. */
function functionBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

/* Line number of the first match of a regex, 1-indexed. */
function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/* ------------------------------------------------------- panel 1: screens */

/* HaTi's screens are the nav entries in index.html paired with the view module
   that renders each one. The pairing is not written down anywhere directly, so
   it is derived in three hops: nav button -> view id -> the render function
   setView() dispatches to -> the file that declares that function. */
function scanScreens(files) {
  const html = text(files, 'index.html');
  const app = text(files, 'js/app.js');
  const warnings = [];
  if (!html || !app) {
    return { screens: [], warnings: ['index.html or js/app.js not found — screens could not be derived.'] };
  }

  /* --- hop 1: nav buttons --- */
  const navEntries = [];
  const btnRe = /<button\s+data-view="([a-zA-Z]+)"[^>]*class="nav-item[^"]*"[^>]*>([\s\S]*?)<\/button>/g;
  for (let m; (m = btnRe.exec(html));) {
    const label = (m[2].match(/<span style="flex:1;">([^<]*)<\/span>/) || [])[1];
    // Which collapsible nav section this button sits in.
    const before = html.slice(0, m.index);
    const secMatches = [...before.matchAll(/data-section="([a-z]+)"/g)];
    navEntries.push({
      view: m[1],
      label: (label || m[1]).replace(/&amp;/g, '&').trim(),
      group: secMatches.length ? secMatches[secMatches.length - 1][1] : null,
      entry: 'nav',
    });
  }
  if (!navEntries.length) warnings.push('No nav entries matched in index.html — the nav markup may have changed shape.');

  /* --- hop 2: setView() dispatch --- */
  const setView = functionBody(app, 'setView') || '';
  const dispatch = new Map();
  for (const m of setView.matchAll(/view\s*===\s*['"]([a-zA-Z]+)['"]\s*\)\s*(\w+)\s*\(/g)) {
    dispatch.set(m[1], m[2]);
  }
  // The trailing `else renderWorkspace();` catches every view without a branch.
  const fallback = (setView.match(/else\s+(\w+)\s*\(\s*\)\s*;/) || [])[1] || null;

  /* --- screens reachable only by URL hash (no nav entry, no session) --- */
  const viewFiles = sourcePaths(files).filter(p => p.startsWith('js/views/'));
  const declaredIn = fn => sourcePaths(files).find(p => new RegExp(`function\\s+${fn}\\s*\\(`).test(text(files, p) || '')) || null;

  const hashEntries = [];
  const appLines = app.split('\n');
  const hashRoutes = [];
  appLines.forEach((line, i) => {
    const hm = line.match(/location\.hash\.match\(\s*\/\^#([a-zA-Z]+)/);
    if (!hm) return;
    hashRoutes.push({ hash: hm[1], line: i + 1 });
    // The handler is the first call, within the next few lines, to a function
    // declared in a view module. That deliberately excludes `fetch` and the
    // auth screens, which are not screens of their own.
    for (let j = i; j < Math.min(i + 4, appLines.length); j++) {
      for (const cm of appLines[j].matchAll(/\b(\w+)\s*\(/g)) {
        const file = declaredIn(cm[1]);
        if (file && viewFiles.includes(file)) {
          hashEntries.push({ view: '#' + hm[1], label: null, group: 'public', entry: 'hash', fn: cm[1], module: file });
          return;
        }
      }
    }
  });

  /* --- hop 3: render function -> module file --- */
  const screens = [];
  for (const nav of navEntries) {
    const fn = dispatch.get(nav.view) || fallback;
    const module = fn ? declaredIn(fn) : null;
    screens.push({
      view: nav.view,
      label: nav.label,
      group: nav.group,
      entry: 'nav',
      renderFn: fn || null,
      module,
      bytes: module ? sizeOf(files, module) : null,
      does: SCREEN_COPY[nav.view] || null,
    });
    if (!fn) warnings.push(`Nav entry "${nav.label}" (${nav.view}) has no branch in setView() and no fallback — its module could not be resolved.`);
    else if (!module) warnings.push(`setView() dispatches "${nav.view}" to ${fn}(), which is not declared in any scanned source file.`);
  }
  for (const h of hashEntries) {
    screens.push({
      view: h.view,
      label: HASH_COPY[h.view]?.label || h.view,
      group: 'public',
      entry: 'hash',
      renderFn: h.fn,
      module: h.module,
      bytes: sizeOf(files, h.module),
      does: HASH_COPY[h.view]?.does || null,
    });
  }

  /* --- flags: one module behind several screens, one module doing several jobs --- */
  const byModule = new Map();
  for (const s of screens) {
    if (!s.module) continue;
    if (!byModule.has(s.module)) byModule.set(s.module, []);
    byModule.get(s.module).push(s.label);
  }
  for (const s of screens) {
    const siblings = s.module ? byModule.get(s.module).filter(l => l !== s.label) : [];
    s.sharedWith = siblings;
  }

  // "Several distinct jobs" is read from the module's own section banners —
  // the `/* ==== TITLE ==== */` blocks the codebase uses to separate concerns —
  // together with how many names it publishes on `window`.
  const moduleFacts = [];
  for (const [module, labels] of byModule) {
    const src = text(files, module) || '';
    const sections = [...src.matchAll(/\/\*\s*=+\s*\n\s*([A-Z][^\n]*?)\s*\n/g)].map(m => m[1].trim());
    const exportCount = windowExportsIn(src).length;
    moduleFacts.push({
      module,
      bytes: sizeOf(files, module),
      screens: labels,
      sections,
      exportCount,
      multiScreen: labels.length > 1,
      multiJob: sections.length > 1,
    });
  }

  /* --- value streams --- */
  const tplSrc = text(files, 'js/templates.js') || '';
  const streams = [];
  const foldersBlock = tplSrc.match(/const FOLDERS\s*=\s*\{([\s\S]*?)\n\};/);
  if (foldersBlock) {
    for (const m of foldersBlock[1].matchAll(/id\s*:\s*'([^']+)'\s*,\s*name\s*:\s*'([^']+)'[^}]*?color\s*:\s*'([^']+)'[^}]*?desc\s*:\s*'([^']*)'/g)) {
      streams.push({ id: m[1], name: m[2], color: m[3], desc: m[4], custom: false });
    }
  } else {
    warnings.push('FOLDERS not found in js/templates.js — the built-in value streams could not be derived.');
  }
  // Custom streams are created by users at runtime and persisted to the
  // browser's localStorage (FOLDER_LS in templates.js). They exist only in a
  // user's browser, so no amount of source reading can enumerate them.
  const customStreamsNote = /localStorage\.getItem\(FOLDER_LS\)/.test(tplSrc)
    ? 'Custom value streams are created by users and saved to their own browser (localStorage), never to the server. They cannot be counted from the source — this list is the built-in set only.'
    : null;

  return { screens, moduleFacts, streams, customStreamsNote, hashRoutes, warnings };
}

/* Every name published on `window` by a module, including the multi-line
   `Object.assign(window, { ... })` blocks this codebase uses. */
function windowExportsIn(src) {
  const names = [];
  const re = /Object\.assign\(\s*window\s*,\s*\{/g;
  for (let m; (m = re.exec(src));) {
    const open = src.indexOf('{', m.index + 'Object.assign('.length);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    const body = src.slice(open + 1, end);
    for (const part of body.split(',')) {
      const name = part.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
}

/* Ranges of the Object.assign(window,{...}) blocks, so the orphan pass can
   exclude a name's own export from its usage count. */
function windowBlockRanges(src) {
  const ranges = [];
  const re = /Object\.assign\(\s*window\s*,\s*\{/g;
  for (let m; (m = re.exec(src));) {
    const open = src.indexOf('{', m.index + 'Object.assign('.length);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { ranges.push([m.index, i + 1]); break; } }
    }
  }
  return ranges;
}

const stripRanges = (src, ranges) => {
  let out = '', last = 0;
  for (const [a, b] of ranges) { out += src.slice(last, a); last = b; }
  return out + src.slice(last);
};

/* --------------------------------------------- panel 2: where money goes */

function scanAi(files) {
  const server = text(files, 'server/server.js');
  const warnings = [];
  if (!server) return { features: [], caps: [], models: {}, warnings: ['server/server.js not found — AI features could not be derived.'] };

  /* Resolved default model per tier. */
  const tierDefaults = {};
  const td = server.match(/AI_TIER_DEFAULTS\s*=\s*\{([^}]*)\}/);
  if (td) for (const m of td[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) tierDefaults[m[1]] = m[2];
  else warnings.push('AI_TIER_DEFAULTS not found — per-tier default models could not be derived.');

  /* The rate limiters, and the settings key + code default each one reads. */
  const limiters = new Map();
  for (const m of server.matchAll(/const\s+(rl\w+)\s*=\s*rateLimit\(\s*'([^']+)'\s*,\s*(?:\(\)\s*=>\s*intSetting\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*(\d+)\s*\)|(\d+))\s*,\s*([\w.*\s]+?)\s*[,)]/g)) {
    limiters.set(m[1], {
      name: m[1], bucket: m[2],
      settingKey: m[3] || null, envVar: m[4] || null,
      def: m[5] ? Number(m[5]) : (m[6] ? Number(m[6]) : null),
      window: m[7].trim(),
    });
  }

  /* Human labels for each feature, straight from the server's own table. */
  const featureLabels = {};
  const fl = server.match(/AI_FEATURE_LABEL\s*=\s*\{([\s\S]*?)\n\};/);
  if (fl) for (const m of fl[1].matchAll(/(\w+)\s*:\s*'([^']*)'/g)) featureLabels[m[1]] = m[2];

  /* Every AI endpoint, with its middleware chain. */
  /* "Every feature that calls Anthropic" — so the test is that the handler
     actually calls anthropicMessages(), not merely that the path starts
     /api/ai/. Several routes under that prefix are configuration and
     allowance admin and cost nothing; they are reported separately rather
     than padding the feature list. */
  const routes = parseRoutes(server);
  const underAiPrefix = routes.filter(r => !r.unparsed && r.path.startsWith('/api/ai/'));
  const aiRoutes = underAiPrefix.filter(r => /anthropicMessages\(/.test(r.body));
  const nonBillingAiRoutes = underAiPrefix
    .filter(r => !/anthropicMessages\(/.test(r.body))
    .map(r => ({ method: r.method.toUpperCase(), path: r.path }));

  const frontendCalls = collectAiCallSites(files);

  const features = aiRoutes.map(r => {
    const feature = (r.middleware.match(/aiFeature\(\s*'([^']+)'\s*\)/) || [])[1] || r.path.split('/').pop();
    const limiterName = (r.middleware.match(/\b(rlAi\w+)\b/) || [])[1] || null;
    const limiter = limiterName ? limiters.get(limiterName) : null;

    /* Tier: read from the anthropicMessages() call inside the handler. It is
       usually a literal; extract chooses per request, which is resolved from
       the ternary that sets it rather than reported as unknown. */
    let tiers = [];
    const call = r.body.match(/anthropicMessages\(\s*key\s*,\s*(?:'(\w+)'|(\w+))/);
    if (call && call[1]) tiers = [call[1]];
    else if (call && call[2]) {
      const v = call[2];
      const tern = r.body.match(new RegExp(`(?:const|let)\\s+${v}\\s*=\\s*[^;]*?\\?\\s*'(\\w+)'\\s*:\\s*'(\\w+)'`));
      if (tern) tiers = [tern[2], tern[1]];        // condition false first: the common path
      else warnings.push(`${r.path}: tier is the variable "${v}" and could not be resolved from the handler.`);
    } else if (!/anthropicMessages\(/.test(r.body)) {
      warnings.push(`${r.path}: no anthropicMessages() call found in the handler — tier and model not derived.`);
    }

    return {
      route: r.path,
      feature,
      label: featureLabels[feature] || null,
      does: FEATURE_COPY[feature] || null,
      tiers,
      models: tiers.map(t => tierDefaults[t] || NOT_DETECTED),
      limiter: limiterName,
      cap: limiter ? limiter.def : null,
      capSetting: limiter ? limiter.settingKey : null,
      capEnv: limiter ? limiter.envVar : null,
      usedBy: frontendCalls.get('ai/' + feature) || [],
    };
  });

  /* The caps and their code defaults. */
  const capDefs = [
    ['aiRateLight', 'Per person, cheap features', 'Rolling 15 minutes'],
    ['aiRateDeep', 'Per person, expensive features', 'Rolling 15 minutes'],
    ['aiDailyLimit', 'Whole workspace, per day', 'Resets at local midnight'],
    ['aiMaxChars', 'Document text per request', 'Longer input is trimmed'],
    ['aiMaxContracts', 'Contracts per portfolio question', 'Applies to graph and search'],
  ];
  const caps = capDefs.map(([key, label, note]) => {
    const m = server.match(new RegExp(`intSetting\\(\\s*'${key}'\\s*,\\s*'(\\w+)'\\s*,\\s*(\\d+)\\s*\\)`));
    if (!m) warnings.push(`Cap "${key}" has no intSetting() call site in server.js — its code default could not be derived.`);
    return { key, label, note, envVar: m ? m[1] : null, codeDefault: m ? Number(m[2]) : null };
  });

  const windowMin = (() => {
    const m = server.match(/AI_WINDOW_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
    return m ? (Number(m[1]) * Number(m[2]) * Number(m[3])) / 60000 : null;
  })();

  const modelsInUse = [...new Set(features.flatMap(f => f.models).filter(m => m && m !== NOT_DETECTED))];

  return { features, caps, tierDefaults, modelsInUse, windowMinutes: windowMin, nonBillingAiRoutes, warnings };
}

/* Where the front end calls each AI endpoint, so a feature can be attributed
   to the screens that use it. */
function collectAiCallSites(files) {
  const map = new Map();
  for (const p of sourcePaths(files)) {
    if (!p.startsWith('js/')) continue;
    const src = text(files, p) || '';
    for (const m of src.matchAll(/api\(\s*['"`](ai\/[a-z]+)['"`]/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      if (!map.get(m[1]).includes(p)) map.get(m[1]).push(p);
    }
  }
  return map;
}

/* Parse every Express route declaration, with its middleware chain and body.
   Routes in this codebase each start a line, which keeps this honest and
   simple; anything that does not parse is reported rather than dropped. */
function parseRoutes(server) {
  const lines = server.split('\n');
  const routes = [];
  const starts = [];
  lines.forEach((line, i) => { if (/^\s*app\.(get|post|put|patch|delete)\(/.test(line)) starts.push(i); });

  starts.forEach((lineIdx, n) => {
    const line = lines[lineIdx];
    const m = line.match(/^\s*app\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*(,([\s\S]*?))?,?\s*(?:async\s*)?\(\s*req/);
    if (!m) { routes.push({ method: null, path: null, raw: line.trim(), line: lineIdx + 1, unparsed: true, middleware: '', body: '' }); return; }
    const endIdx = n + 1 < starts.length ? starts[n + 1] : lines.length;
    routes.push({
      method: m[1],
      path: m[2],
      middleware: (m[4] || '').trim(),
      line: lineIdx + 1,
      body: lines.slice(lineIdx, endIdx).join('\n'),
      unparsed: false,
    });
  });
  return routes;
}

/* ---------------------------------------------- panel 3: where things kept */

function scanStorage(files) {
  const server = text(files, 'server/server.js');
  const warnings = [];
  if (!server) return { tables: [], warnings: ['server/server.js not found — storage could not be derived.'] };

  const tables = [];
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  for (let m; (m = re.exec(server));) {
    const body = m[2];
    // Column names are the first token of each top-level comma-separated part.
    const cols = [];
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; } else cur += ch;
    }
    cols.push(cur);
    const columns = cols
      .map(c => c.trim().split(/\s+/)[0])
      .filter(c => /^[a-z_]\w*$/i.test(c) && !/^(primary|unique|foreign|check|constraint)$/i.test(c));
    tables.push({ name: m[1], columns, line: lineOf(server, m.index) });
  }
  if (!tables.length) warnings.push('No CREATE TABLE statements matched in server/server.js.');

  /* What goes into the settings record. The settings table is a key/json
     store, so the interesting question is which keys are written and whether
     any of them holds a whole collection. */
  const settingKeys = [...new Set([...server.matchAll(/setSetting\(\s*'(\w+)'/g)].map(m => m[1]))].sort();

  /* A collection stored inside a single blob that gets rewritten on every
     save. Derived: a key written as `{ ...s, <name>: <array> }` into another
     settings key, plus a front-end write path that rewrites the whole list. */
  const blobs = [];
  for (const m of server.matchAll(/setSetting\(\s*'(\w+)'\s*,\s*\{\s*\.\.\.\s*\w+\s*,\s*(\w+)\s*:\s*(\w+)\s*\}/g)) {
    const [, record, field] = m;
    const isList = new RegExp(`Array\\.isArray\\(\\s*${m[3]}\\s*\\)`).test(server) ||
                   new RegExp(`${field}\\s*must be an array`).test(server);
    blobs.push({
      record, field, isList,
      note: `"${field}" is stored inside the "${record}" settings record rather than as its own rows, so the whole list is rewritten every time any setting is saved.`,
      line: lineOf(server, m.index),
    });
  }
  // The whole-record write is what makes the above expensive — confirm it exists.
  const rewritesWholeRecord = /setSetting\(\s*'appSettings'\s*,\s*req\.body/.test(server);

  return { tables, settingKeys, blobs, rewritesWholeRecord, warnings };
}

/* ---------------------------------------------- panel 4: what breaks what */

/* The relationships in this panel are judgements about meaning, not something
   a parser can read out of code — so they are hand-written in
   data/dependencies.js. What the scan does is *validate* them: every subsystem
   and every field named there must still exist in HaTi's source. Stale entries
   come back as warnings and the panel shows them, so the map degrades visibly
   instead of quietly lying. */
function scanDependencies(files) {
  const warnings = [];
  const all = sourcePaths(files);
  const corpus = new Map(all.map(p => [p, text(files, p) || '']));

  const existsSomewhere = (needle) => {
    for (const [, src] of corpus) if (src.includes(needle)) return true;
    return false;
  };
  const identExists = (name) => {
    for (const [, src] of corpus) if (wordCount(src, name) > 0) return true;
    return false;
  };

  const subsystemIds = new Set(DEPENDENCIES.subsystems.map(s => s.id));

  for (const s of DEPENDENCIES.subsystems) {
    // Each subsystem claims a file it lives in and an identifier that proves it.
    if (s.file && !files.has(s.file)) {
      warnings.push(`Subsystem "${s.title}" claims to live in ${s.file}, which no longer exists in HaTi.`);
    } else if (s.proof && !identExists(s.proof)) {
      warnings.push(`Subsystem "${s.title}" is anchored to "${s.proof}", which no longer appears anywhere in HaTi.`);
    }
  }

  for (const item of DEPENDENCIES.items) {
    for (const f of item.fields || []) {
      if (!existsSomewhere(f)) warnings.push(`"${item.label}" names the field "${f}", which no longer appears anywhere in HaTi.`);
    }
    for (const id of [...(item.reads || []), ...(item.risk || [])]) {
      if (!subsystemIds.has(id)) warnings.push(`"${item.label}" points at the subsystem "${id}", which is not defined in data/dependencies.js.`);
    }
  }

  return {
    items: DEPENDENCIES.items,
    subsystems: DEPENDENCIES.subsystems,
    warnings,
    handMaintained: true,
    source: 'data/dependencies.js',
  };
}

/* ----------------------------------------------- panel 5: not finished */

function scanGaps(files) {
  const warnings = [];
  const gaps = [];

  /* --- code markers --- */
  let markerFilesScanned = 0;
  for (const p of sourcePaths(files)) {
    markerFilesScanned++;
    const src = text(files, p) || '';
    src.split('\n').forEach((line, i) => {
      const m = line.match(/\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/);
      if (!m) return;
      gaps.push({
        title: m[2].trim().replace(/\s*\*\/\s*$/, '') || `${m[1]} with no note`,
        detail: null,
        source: `${p} · line ${i + 1}`,
        marker: m[1],
        // The marker word is not a severity. Nothing here states one.
        severity: null,
      });
    });
  }

  /* --- README: "Honest limitations" --- */
  const readme = text(files, 'README.md');
  if (readme) {
    const sec = sectionOf(readme, /^##\s+Honest limitations/im);
    if (sec === null) warnings.push('README.md has no "Honest limitations" heading — that source contributed nothing.');
    else for (const b of bullets(sec)) gaps.push({ ...toGap(b), source: 'README · honest limitations' });
  } else warnings.push('README.md not found.');

  /* --- SECURITY.md --- */
  const security = text(files, 'SECURITY.md');
  if (security) {
    /* Taking every bullet in SECURITY.md would be wrong: most of them state
       what the product *does* protect, which is not a gap. Only bullets under
       a limitation-flavoured heading, or bullets that explicitly mark
       themselves as outstanding, belong in this panel. */
    const gapHeading = /limitation|outstanding|not yet|known/i;
    const secs = splitSections(security);
    for (const { heading, body } of secs) {
      const headingIsGap = gapHeading.test(heading);
      for (const b of bullets(body)) {
        const marked = /\*\*(not yet[^*]*|outstanding[^*]*|caveat)\*\*/i.test(b);
        if (!headingIsGap && !marked) continue;
        gaps.push({ ...toGap(b), source: `SECURITY.md · ${heading.replace(/^#+\s*/, '')}` });
      }
    }
    if (!gaps.some(g => g.source.startsWith('SECURITY.md'))) {
      warnings.push('No limitation bullets matched in SECURITY.md — its headings may have changed.');
    }
  } else warnings.push('SECURITY.md not found.');

  const markerCount = gaps.filter(g => g.marker).length;
  return {
    gaps,
    markerCount,
    markerFilesScanned,
    markerNote: markerCount === 0
      ? `No TODO, FIXME, HACK or XXX markers anywhere in the ${markerFilesScanned} source files scanned. Everything below comes from the written documents.`
      : null,
    warnings,
  };
}

/* A markdown bullet becomes a gap. The first bolded run, or the first
   sentence, is the title; the rest is the detail. Severity is only set when
   the source itself states one — nothing in HaTi's documents does, so it
   stays null and the panel shows that rather than inventing a colour. */
function toGap(bullet) {
  const flat = bullet.replace(/\s+/g, ' ').trim();
  const bold = flat.match(/^\*\*([^*]+)\*\*\.?\s*(.*)$/);
  if (bold) {
    const lead = stripMd(bold[1]);
    const rest = stripMd(bold[2]);
    // A bolded run ending in a colon is a label ("Not yet integrated:"), not
    // the finding itself — the sentence after it is what the reader needs.
    if (/:$/.test(lead) && rest) {
      const stop = rest.indexOf('. ');
      return {
        title: stop > 0 ? rest.slice(0, stop) : rest,
        detail: stop > 0 ? rest.slice(stop + 2) : null,
        severity: null,
        marker: lead.replace(/:$/, ''),
      };
    }
    return { title: lead.replace(/[.:]$/, ''), detail: rest || null, severity: null, marker: null };
  }
  const dot = flat.indexOf('. ');
  if (dot > 0 && dot < 120) return { title: stripMd(flat.slice(0, dot)), detail: stripMd(flat.slice(dot + 2)) || null, severity: null, marker: null };
  return { title: stripMd(flat).slice(0, 160), detail: flat.length > 160 ? stripMd(flat) : null, severity: null, marker: null };
}

const stripMd = s => String(s || '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\*\*|__|`/g, '')
  .trim();

/* The body of a markdown section, up to the next heading of the same level. */
function sectionOf(md, headingRe) {
  const lines = md.split('\n');
  const start = lines.findIndex(l => headingRe.test(l));
  if (start === -1) return null;
  const level = (lines[start].match(/^#+/) || ['##'])[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

function splitSections(md) {
  const lines = md.split('\n');
  const out = [];
  let heading = '(top)', buf = [];
  for (const line of lines) {
    if (/^#{2,}\s/.test(line)) { out.push({ heading, body: buf.join('\n') }); heading = line; buf = []; }
    else buf.push(line);
  }
  out.push({ heading, body: buf.join('\n') });
  return out;
}

/* Top-level markdown bullets, with their wrapped continuation lines folded in. */
function bullets(md) {
  const out = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^[-*]\s+(.*)$/);
    if (m) { if (cur) out.push(cur); cur = m[1]; }
    else if (cur !== null && /^\s{2,}\S/.test(line)) cur += ' ' + line.trim();
    else if (cur !== null && !line.trim()) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------- panel 6: open to the public */

function scanPublic(files, hashRoutes) {
  const server = text(files, 'server/server.js');
  const warnings = [];
  if (!server) return { routes: [], hashes: [], warnings: ['server/server.js not found.'] };

  const routes = parseRoutes(server);
  const unparsed = routes.filter(r => r.unparsed);
  if (unparsed.length) warnings.push(`${unparsed.length} route declaration(s) in server.js did not parse and were not checked for authentication: ${unparsed.map(r => 'line ' + r.line).join(', ')}.`);

  const open = routes
    .filter(r => !r.unparsed && !/\bauth\b/.test(r.middleware))
    .map(r => ({
      method: r.method.toUpperCase(),
      path: r.path,
      middleware: r.middleware ? r.middleware.split(',').map(s => s.trim()).filter(Boolean) : [],
      line: r.line,
      // Serving the SPA shell itself is not an unauthenticated data surface.
      servesShell: /res\.sendFile\(\s*INDEX\s*\)/.test(r.body),
      // "No auth middleware" is not the same as "anyone can read it". Two
      // things narrow it, and both are visible in the source: a credential
      // checked inside the handler, and an unguessable token in the path.
      tokenGuarded: /\bsafeEq\(|Bearer\s|req\.headers\.authorization/i.test(r.body),
      tokenInPath: /:token\b/.test(r.path),
    }));

  const app = text(files, 'js/app.js') || '';
  const hashes = (hashRoutes || []).map(h => ({
    hash: '#' + h.hash,
    line: h.line,
    label: HASH_COPY['#' + h.hash]?.label || null,
    detail: HASH_COPY['#' + h.hash]?.public || null,
    // Proof it runs before any session is established: it is handled inside
    // boot() ahead of the /api/status call that resolves the session.
    beforeSession: app.indexOf(`#${h.hash}`) < app.indexOf("fetch('api/status'"),
  }));

  return { routes: open, hashes, totalRoutes: routes.length, warnings };
}

/* --------------------------------------------------- panel 7: what changed */

const AREA_RULES = [
  [/^js\/views\/contract\.js$|^js\/(richdoc|richpaste|pdfrich|ocr|signature)\.js$/, 'documents'],
  [/^js\/views\/migration\.js$|^js\/dedupe\.js$/, 'migration'],
  [/^js\/views\/library\.js$|^js\/(templates|templatefields|wizard|playbook)\.js$/, 'templates'],
  [/^js\/views\/advice(portal)?\.js$|^js\/advice\.js$/, 'advice'],
  [/^server\//, 'server'],
  [/^js\/views\/settings\.js$|^js\/approvals\.js$/, 'settings'],
];

function areasFor(paths) {
  if (!paths) return null;
  const out = new Set();
  for (const p of paths) {
    const hit = AREA_RULES.find(([re]) => re.test(p));
    if (hit) out.add(hit[1]);
  }
  return [...out];
}

function scanChanges(commits) {
  if (!commits) return { changes: [], warnings: ['Commit history was not fetched.'] };
  const warnings = [];
  let missingFiles = 0;
  const changes = commits.map(c => {
    const subject = (c.commit?.message || '').split('\n')[0].trim();
    const areas = areasFor(c._files);
    if (areas === null) missingFiles++;
    return {
      sha: (c.sha || '').slice(0, 7),
      date: c.commit?.author?.date || c.commit?.committer?.date || null,
      subject,
      areas,
      fileCount: c._files ? c._files.length : null,
    };
  });
  if (missingFiles) warnings.push(`${missingFiles} of ${commits.length} commits could not have their file lists fetched — their areas show as not detected.`);
  return { changes, warnings };
}

/* --------------------------------------------------- panel 8: getting bulky */

const BULK_THRESHOLD = 60 * 1024;

function scanWeight(files) {
  const warnings = [];
  const paths = [...files.keys()]
    .filter(p => (p.startsWith('js/') || p.startsWith('server/')) && p.endsWith('.js'))
    .sort();

  const sized = paths
    .map(p => ({ path: p, bytes: files.get(p).length }))
    .sort((a, b) => b.bytes - a.bytes);

  /* The orphan pass. This codebase attaches everything it shares to `window`
     via Object.assign(window, {...}), which makes "is this name used anywhere?"
     a cheap and genuinely useful question: a name that appears only in its own
     declaration and its own export block is reachable by nothing. */
  const corpus = sourcePaths(files).map(p => ({ path: p, src: text(files, p) || '' }));
  const stripped = corpus.map(({ path, src }) => ({ path, src: stripRanges(src, windowBlockRanges(src)) }));

  const orphans = [];
  const exportedFrom = new Map();
  for (const { path, src } of corpus) {
    for (const name of windowExportsIn(src)) {
      if (!exportedFrom.has(name)) exportedFrom.set(name, path);
    }
  }
  for (const [name, from] of exportedFrom) {
    // Outside every export block, how many times does this name appear? One
    // occurrence is its own declaration; anything more is a real use.
    let uses = 0;
    for (const { src } of stripped) uses += wordCount(src, name);
    if (uses <= 1) orphans.push({ name, exportedFrom: from, uses });
  }
  orphans.sort((a, b) => a.exportedFrom.localeCompare(b.exportedFrom) || a.name.localeCompare(b.name));

  if (!exportedFrom.size) warnings.push('No Object.assign(window, {...}) blocks found — the orphan check produced nothing.');

  return {
    files: sized,
    threshold: BULK_THRESHOLD,
    overThreshold: sized.filter(f => f.bytes > BULK_THRESHOLD).length,
    orphans,
    exportCount: exportedFrom.size,
    warnings,
  };
}

/* ---------------------------------------------------------------- assemble */

export function buildScan({ files, commits, repo, ref, requestCount }) {
  const screens = scanScreens(files);
  const ai = scanAi(files);
  const storage = scanStorage(files);
  const deps = scanDependencies(files);
  const gaps = scanGaps(files);
  const publicSurface = scanPublic(files, screens.hashRoutes);
  const changes = scanChanges(commits);
  const weight = scanWeight(files);

  /* Validate the hand-written plain-English copy against what was derived, the
     same way the dependency map is validated: an entry for a screen or feature
     that no longer exists is stale, and a screen or feature with no entry
     shows "not detected" rather than nothing. */
  const copyWarnings = [];
  const screenViews = new Set(screens.screens.map(s => s.view));
  for (const key of Object.keys(SCREEN_COPY)) {
    if (!screenViews.has(key)) copyWarnings.push(`data/copy.js describes a screen "${key}" that no longer exists in HaTi.`);
  }
  const featureKeys = new Set(ai.features.map(f => f.feature));
  for (const key of Object.keys(FEATURE_COPY)) {
    if (!featureKeys.has(key)) copyWarnings.push(`data/copy.js describes an AI feature "${key}" that no longer has an endpoint in HaTi.`);
  }
  for (const s of screens.screens) if (!s.does) copyWarnings.push(`Screen "${s.label}" (${s.view}) has no plain-English description in data/copy.js.`);
  for (const f of ai.features) if (!f.does) copyWarnings.push(`AI feature "${f.feature}" has no plain-English description in data/copy.js.`);

  const warnings = [
    ...screens.warnings, ...ai.warnings, ...storage.warnings, ...deps.warnings,
    ...gaps.warnings, ...publicSurface.warnings, ...changes.warnings, ...weight.warnings,
    ...copyWarnings,
  ];

  return {
    scannedAt: new Date().toISOString(),
    repo, ref,
    commit: commits?.[0]?.sha?.slice(0, 7) || null,
    requestCount,
    fileCount: files.size,
    screens: screens.screens,
    moduleFacts: screens.moduleFacts,
    streams: screens.streams,
    customStreamsNote: screens.customStreamsNote,
    ai,
    storage,
    dependencies: deps,
    gaps,
    public: publicSurface,
    changes: changes.changes,
    weight,
    warnings,
  };
}

export { NOT_DETECTED };
