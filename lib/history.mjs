/* HaTi-Mapper — the 72-hour change log.
 *
 * The scan says what HaTi looks like right now. This says what has MOVED, by
 * keeping a compact fingerprint of each scan and comparing it with the one
 * before. Anything the comparison notices becomes a plain-English event: a new
 * screen, a route that lost its login check, a file that crossed the 60 KB
 * line, a gap that was closed.
 *
 * Two deliberate choices:
 *
 *   - A snapshot is only kept when something actually changed. Scanning the
 *     same unchanged code fifty times adds one entry, not fifty, so the log
 *     stays readable and small.
 *   - Nothing here holds HaTi's content. A snapshot is names, paths, counts
 *     and byte sizes — the same class of information the dashboard already
 *     shows — so the change log can never become a back door to contract data.
 *
 * Retention is 72 hours. The baseline snapshot is always kept even when older,
 * because without it the next scan has nothing to compare against.
 */

import fs from 'node:fs';
import path from 'node:path';

const RETENTION_MS = 72 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 300;

/* ------------------------------------------------------------- snapshot */

/* Reduce a full scan payload to the small set of facts worth watching. */
export function snapshot(scan) {
  const s = scan || {};
  return {
    at: s.scannedAt || new Date().toISOString(),
    commit: s.commit || null,
    screens: (s.screens || []).map(x => ({ view: x.view, label: x.label, module: x.module, bytes: x.bytes })),
    features: (s.ai?.features || []).map(f => ({
      route: f.route, label: f.label, tiers: (f.tiers || []).join('+'),
      models: (f.models || []).join('+'), cap: f.cap, usedBy: (f.usedBy || []).length,
    })),
    tables: (s.storage?.tables || []).map(t => ({ name: t.name, cols: (t.columns || []).length })),
    openRoutes: (s.public?.routes || []).map(r => `${r.method} ${r.path}`),
    hashRoutes: (s.public?.hashes || []).map(h => h.hash),
    gaps: (s.gaps?.gaps || []).map(g => g.title),
    files: (s.weight?.files || []).map(f => ({ path: f.path, bytes: f.bytes })),
    orphans: (s.weight?.orphans || []).map(o => `${o.name} (${o.exportedFrom})`),
    streams: (s.streams || []).map(x => x.id),
    depWarnings: (s.dependencies?.warnings || []).length,
    markerCount: s.gaps?.markerCount ?? null,
  };
}

/* ------------------------------------------------------------- the diff */

const byKey = (arr, k) => new Map((arr || []).map(x => [x[k], x]));
const KB = b => Math.round(b / 1024) + ' KB';

/* Compare two snapshots and describe the difference the way you would say it
   out loud. `weight` orders the list: 3 wants attention, 1 is routine. */
export function diff(prev, next) {
  const out = [];
  const add = (weight, kind, text) => out.push({ weight, kind, text });

  /* --- screens --- */
  const pScreens = byKey(prev.screens, 'view'), nScreens = byKey(next.screens, 'view');
  for (const [view, s] of nScreens) {
    if (!pScreens.has(view)) add(2, 'screens', `A new screen appeared: “${s.label}”, in ${s.module || 'an unknown file'}.`);
  }
  for (const [view, s] of pScreens) {
    if (!nScreens.has(view)) add(2, 'screens', `The screen “${s.label}” is gone.`);
  }
  for (const [view, s] of nScreens) {
    const p = pScreens.get(view);
    if (!p) continue;
    if (p.module !== s.module) add(2, 'screens', `“${s.label}” moved from ${p.module} to ${s.module}.`);
    if (p.label !== s.label) add(1, 'screens', `The screen “${p.label}” was renamed to “${s.label}”.`);
  }

  /* --- AI features: the ones that cost money --- */
  const pF = byKey(prev.features, 'route'), nF = byKey(next.features, 'route');
  for (const [route, f] of nF) {
    if (!pF.has(route)) add(3, 'ai', `A new AI feature was added: ${f.label || route}. It calls Anthropic, so it costs money to run.`);
  }
  for (const [route, f] of pF) {
    if (!nF.has(route)) add(2, 'ai', `The AI feature ${f.label || route} was removed.`);
  }
  for (const [route, f] of nF) {
    const p = pF.get(route);
    if (!p) continue;
    if (p.models !== f.models) add(3, 'ai', `${f.label || route} changed model: ${p.models || 'none'} → ${f.models || 'none'}. That changes what it costs per use.`);
    if (p.cap !== f.cap) add(2, 'ai', `${f.label || route} changed its usage cap: ${p.cap} → ${f.cap} per 15 minutes.`);
    if (p.tiers !== f.tiers) add(2, 'ai', `${f.label || route} moved between the cheap and expensive tiers: ${p.tiers} → ${f.tiers}.`);
    if (p.usedBy > 0 && f.usedBy === 0) add(3, 'ai', `Nothing calls ${f.label || route} any more, but the feature is still there — a paid endpoint with no caller.`);
    if (p.usedBy === 0 && f.usedBy > 0) add(1, 'ai', `${f.label || route} is now being called from the app; before, nothing used it.`);
  }

  /* --- doors that need no login: the security-relevant one --- */
  const pOpen = new Set(prev.openRoutes || []), nOpen = new Set(next.openRoutes || []);
  for (const r of nOpen) if (!pOpen.has(r)) add(3, 'public', `A new address works without logging in: ${r}. Worth checking that is intended.`);
  for (const r of pOpen) if (!nOpen.has(r)) add(2, 'public', `${r} no longer works without logging in.`);
  const pHash = new Set(prev.hashRoutes || []), nHash = new Set(next.hashRoutes || []);
  for (const h of nHash) if (!pHash.has(h)) add(3, 'public', `A new link type opens without a login: ${h}.`);
  for (const h of pHash) if (!nHash.has(h)) add(2, 'public', `The link type ${h} no longer opens without a login.`);

  /* --- storage --- */
  const pT = byKey(prev.tables, 'name'), nT = byKey(next.tables, 'name');
  for (const [name, t] of nT) if (!pT.has(name)) add(2, 'data', `A new place to store things was added: the “${name}” table, with ${t.cols} columns.`);
  for (const [name] of pT) if (!nT.has(name)) add(3, 'data', `The “${name}” table is gone. Anything it held goes with it.`);
  for (const [name, t] of nT) {
    const p = pT.get(name);
    if (p && p.cols !== t.cols) add(1, 'data', `The “${name}” table went from ${p.cols} to ${t.cols} columns.`);
  }

  /* --- known gaps --- */
  const pG = new Set(prev.gaps || []), nG = new Set(next.gaps || []);
  for (const g of nG) if (!pG.has(g)) add(2, 'gaps', `A new known gap was written down: “${g}”.`);
  for (const g of pG) if (!nG.has(g)) add(1, 'gaps', `A known gap was closed or removed from the documents: “${g}”.`);
  if (prev.markerCount != null && next.markerCount != null && prev.markerCount !== next.markerCount) {
    add(1, 'gaps', `Notes left in the code (TODO / FIXME) went from ${prev.markerCount} to ${next.markerCount}.`);
  }

  /* --- file sizes --- */
  const THRESHOLD = 60 * 1024;
  const pFiles = byKey(prev.files, 'path'), nFiles = byKey(next.files, 'path');
  for (const [p, f] of nFiles) {
    if (!pFiles.has(p)) { add(1, 'weight', `A new file appeared: ${p} (${KB(f.bytes)}).`); continue; }
    const was = pFiles.get(p).bytes;
    if (was <= THRESHOLD && f.bytes > THRESHOLD) add(2, 'weight', `${p} crossed the 60 KB line — it is now ${KB(f.bytes)} and getting hard to work on.`);
    else if (was > THRESHOLD && f.bytes <= THRESHOLD) add(1, 'weight', `${p} dropped back under 60 KB (${KB(f.bytes)}).`);
    else if (Math.abs(f.bytes - was) >= 8 * 1024) {
      add(1, 'weight', `${p} ${f.bytes > was ? 'grew' : 'shrank'} from ${KB(was)} to ${KB(f.bytes)}.`);
    }
  }
  for (const [p] of pFiles) if (!nFiles.has(p)) add(2, 'weight', `The file ${p} was deleted.`);

  /* --- unused exports --- */
  const pO = new Set(prev.orphans || []), nO = new Set(next.orphans || []);
  const newOrphans = [...nO].filter(o => !pO.has(o));
  const goneOrphans = [...pO].filter(o => !nO.has(o));
  if (newOrphans.length) add(1, 'weight', `${newOrphans.length} more name${newOrphans.length === 1 ? ' is' : 's are'} now unused: ${newOrphans.slice(0, 4).join(', ')}${newOrphans.length > 4 ? '…' : ''}.`);
  if (goneOrphans.length) add(1, 'weight', `${goneOrphans.length} previously-unused name${goneOrphans.length === 1 ? '' : 's'} ${goneOrphans.length === 1 ? 'is' : 'are'} now used or removed.`);

  /* --- value streams --- */
  const pS = new Set(prev.streams || []), nS = new Set(next.streams || []);
  for (const x of nS) if (!pS.has(x)) add(1, 'screens', `A new built-in value stream was added: ${x}.`);
  for (const x of pS) if (!nS.has(x)) add(2, 'screens', `The built-in value stream ${x} was removed.`);

  /* --- the hand-written map going stale --- */
  if (next.depWarnings > (prev.depWarnings || 0)) {
    add(3, 'map', `The “what breaks what” map is now out of date in ${next.depWarnings} place${next.depWarnings === 1 ? '' : 's'} — HaTi changed underneath it.`);
  } else if (prev.depWarnings > 0 && next.depWarnings === 0) {
    add(1, 'map', `The “what breaks what” map is back in step with the code.`);
  }

  return out;
}

/* ------------------------------------------------------------ the store */

export class History {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'history.json') : null;
    this.entries = [];      // [{ at, lastSeen, commit, snap, events }]
    this.writable = true;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.entries)) this.entries = data.entries;
      this._prune();
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[history] could not read the change log:', e.message);
    }
  }

  _save() {
    if (!this.file || !this.writable) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ v: 1, entries: this.entries }));
    } catch (e) {
      // A read-only filesystem is survivable: the log keeps working in memory
      // for the life of this process. Say so once rather than on every scan.
      this.writable = false;
      console.warn('[history] the change log cannot be written to disk, so it will be lost on restart:', e.message);
    }
  }

  _prune() {
    const cutoff = Date.now() - RETENTION_MS;
    // Keep everything inside the window, plus the newest entry outside it so
    // there is always something to compare the next scan against.
    const inWindow = this.entries.filter(e => new Date(e.lastSeen || e.at).getTime() >= cutoff);
    if (inWindow.length !== this.entries.length) {
      const older = this.entries.filter(e => new Date(e.lastSeen || e.at).getTime() < cutoff);
      const baseline = older.length ? [older[older.length - 1]] : [];
      this.entries = [...baseline, ...inWindow];
    }
    if (this.entries.length > MAX_SNAPSHOTS) this.entries = this.entries.slice(-MAX_SNAPSHOTS);
  }

  /* Record a scan. Returns the events this scan introduced (empty when
     nothing moved). */
  record(scan) {
    const snap = snapshot(scan);
    const last = this.entries[this.entries.length - 1];

    if (!last) {
      this.entries.push({ at: snap.at, lastSeen: snap.at, commit: snap.commit, snap, events: [], baseline: true });
      this._save();
      return [];
    }

    const events = diff(last.snap, snap);
    if (!events.length) {
      // Nothing moved — just note that we looked, so retention stays honest.
      last.lastSeen = snap.at;
      this._save();
      return [];
    }

    this.entries.push({ at: snap.at, lastSeen: snap.at, commit: snap.commit, snap, events });
    this._prune();
    this._save();
    return events;
  }

  /* Everything noticed within the window, newest first. */
  changes(hours = 72) {
    const cutoff = Date.now() - Math.min(hours, 72) * 60 * 60 * 1000;
    return this.entries
      .filter(e => !e.baseline && e.events.length && new Date(e.at).getTime() >= cutoff)
      .map(e => ({ at: e.at, commit: e.commit, events: e.events }))
      .reverse();
  }

  /* A short status line for the panel and for the assistant's system prompt. */
  status() {
    const first = this.entries[0], last = this.entries[this.entries.length - 1];
    const changed = this.changes(72);
    return {
      watching: !!first,
      since: first ? (first.at) : null,
      lastLookedAt: last ? (last.lastSeen || last.at) : null,
      snapshots: this.entries.length,
      changeCount: changed.reduce((n, c) => n + c.events.length, 0),
      retentionHours: 72,
      durable: this.writable && !!this.file,
    };
  }
}
