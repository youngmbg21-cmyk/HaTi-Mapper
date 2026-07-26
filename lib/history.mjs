/* HaTi-Mapper — the change log.
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
 * The working set is 72 hours, and that is still what the panel shows by
 * default. The baseline snapshot is always kept even when older, because
 * without it the next scan has nothing to compare against.
 *
 * Nothing is thrown away any more. Every round of changes is also appended to
 * an archive file, alongside a handful of measurements — total bytes, largest
 * file, how many open routes, how many gaps — so questions like "has this been
 * growing every week for a month?" have something to answer from. The archive
 * holds the same class of information as the snapshots: names, paths, counts
 * and byte sizes, and nothing else. It is capped so it cannot grow for ever.
 */

import fs from 'node:fs';
import path from 'node:path';

const RETENTION_MS = 72 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 300;

/* How far back the archive can be asked about: 90 days. Past that the answer
   would be shaped more by how often the service happened to be awake than by
   anything about HaTi. */
export const MAX_HISTORY_HOURS = 2160;

/* Ceilings, so a service left running for a year cannot fill its disk. Oldest
   goes first. Ten thousand events is years of ordinary use — the log only
   grows when something actually moves. */
const MAX_ARCHIVE_EVENTS = 10000;
const MAX_ARCHIVE_POINTS = 5000;

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
    // How much of what the scanner looks for it could actually read. Kept here
    // so a falling number is itself something that can be watched and alerted
    // on — it is the early warning that a HaTi refactor broke the parsing.
    health: s.health?.percent ?? null,
  };
}

/* A snapshot reduced further still, to the numbers a line can be drawn
   through. One of these is kept per round of changes, for ever (within the
   cap), which is what makes a trend answerable at all. Deliberately numbers
   only: no names, no paths. */
export function measure(snap) {
  const files = snap.files || [];
  return {
    at: snap.at,
    files: files.length,
    bytes: files.reduce((n, f) => n + (f.bytes || 0), 0),
    largest: files.reduce((n, f) => Math.max(n, f.bytes || 0), 0),
    openRoutes: (snap.openRoutes || []).length,
    hashRoutes: (snap.hashRoutes || []).length,
    gaps: (snap.gaps || []).length,
    tables: (snap.tables || []).length,
    features: (snap.features || []).length,
    health: snap.health ?? null,
    dailyCostUsd: snap.dailyCostUsd ?? null,
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

  /* --- the scanner itself losing its grip --- */
  if (prev.health != null && next.health != null && next.health <= prev.health - 3) {
    add(next.health < 90 ? 3 : 2, 'map',
      `The scanner can read less of HaTi than it could: ${prev.health}% → ${next.health}%. ` +
      `Usually that means something moved and the Mapper is now guessing less, not that HaTi got worse.`);
  } else if (prev.health != null && next.health != null && next.health >= prev.health + 3) {
    add(1, 'map', `The scanner can read more of HaTi than it could: ${prev.health}% → ${next.health}%.`);
  }

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
    this.archiveFile = dir ? path.join(dir, 'history-archive.json') : null;
    this.entries = [];                          // [{ at, lastSeen, commit, snap, events }]
    this.archive = { rounds: [], points: [] };  // everything ever noticed, capped
    this.writable = true;
    this.archiveWritable = true;
    this._load();
    this._loadArchive();
  }

  _loadArchive() {
    if (!this.archiveFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.archiveFile, 'utf8'));
      this.archive = {
        rounds: Array.isArray(data.rounds) ? data.rounds : [],
        points: Array.isArray(data.points) ? data.points : [],
      };
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[history] the archive could not be read:', e.message);
    }
  }

  _saveArchive() {
    if (!this.archiveFile || !this.archiveWritable) return;
    try {
      fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
      fs.writeFileSync(this.archiveFile, JSON.stringify({ v: 1, ...this.archive }));
    } catch (e) {
      this.archiveWritable = false;
      console.warn('[history] the archive cannot be written to disk, so nothing older than 72 hours will be kept:', e.message);
    }
  }

  /* Everything the working set will eventually drop goes in here first, at the
     moment it is noticed rather than at the moment it would be discarded — so
     a restart between the two cannot lose it. */
  _appendArchive(round, point) {
    if (round && !this.archive.rounds.some(r => r.at === round.at)) this.archive.rounds.push(round);
    if (point) this.archive.points.push(point);

    // Trim from the front until the event count is back under the ceiling.
    let events = 0, keepFrom = 0;
    for (let i = this.archive.rounds.length - 1; i >= 0; i--) {
      events += this.archive.rounds[i].events.length;
      if (events > MAX_ARCHIVE_EVENTS) { keepFrom = i + 1; break; }
    }
    if (keepFrom) this.archive.rounds = this.archive.rounds.slice(keepFrom);
    if (this.archive.points.length > MAX_ARCHIVE_POINTS) {
      this.archive.points = this.archive.points.slice(-MAX_ARCHIVE_POINTS);
    }
    this._saveArchive();
  }

  get archivedEventCount() {
    return this.archive.rounds.reduce((n, r) => n + r.events.length, 0);
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
    // there is always something to compare the next scan against. What falls
    // out here is not lost: it was written to the archive when it happened.
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
      // The first measurement, so a trend has somewhere to start from.
      this._appendArchive(null, measure(snap));
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
    this._appendArchive({ at: snap.at, commit: snap.commit, events }, measure(snap));
    return events;
  }

  /* Everything noticed within the window, newest first. Up to 72 hours this is
     the working set, exactly as it always was. Past that it comes from the
     archive, merged with the working set so a round is never listed twice and
     never missing because the archive could not be written. */
  changes(hours = 72) {
    const h = Math.min(Math.max(Number(hours) || 72, 1), MAX_HISTORY_HOURS);
    const cutoff = Date.now() - h * 60 * 60 * 1000;

    const live = this.entries
      .filter(e => !e.baseline && e.events.length && new Date(e.at).getTime() >= cutoff)
      .map(e => ({ at: e.at, commit: e.commit, events: e.events }));
    if (h <= 72) return live.reverse();

    const seen = new Set(live.map(r => r.at));
    const older = this.archive.rounds.filter(r => !seen.has(r.at) && new Date(r.at).getTime() >= cutoff);
    return [...older, ...live]
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      .reverse();
  }

  /* The measurement series, oldest first, for drawing a line through. */
  points(hours = MAX_HISTORY_HOURS) {
    const h = Math.min(Math.max(Number(hours) || MAX_HISTORY_HOURS, 1), MAX_HISTORY_HOURS);
    const cutoff = Date.now() - h * 60 * 60 * 1000;
    const seen = new Set();
    const out = [];
    for (const p of this.archive.points) {
      if (new Date(p.at).getTime() < cutoff || seen.has(p.at)) continue;
      seen.add(p.at);
      out.push(p);
    }
    // Anything recorded this process but not yet in the archive — a read-only
    // disk, say — still belongs in the picture.
    for (const e of this.entries) {
      if (seen.has(e.at) || new Date(e.at).getTime() < cutoff) continue;
      seen.add(e.at);
      out.push(measure(e.snap));
    }
    return out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  /* A short status line for the panel and for the assistant's system prompt. */
  status() {
    const first = this.entries[0], last = this.entries[this.entries.length - 1];
    const changed = this.changes(72);
    const oldest = this.archive.rounds[0] || this.archive.points[0] || null;
    return {
      watching: !!first,
      since: first ? (first.at) : null,
      lastLookedAt: last ? (last.lastSeen || last.at) : null,
      snapshots: this.entries.length,
      changeCount: changed.reduce((n, c) => n + c.events.length, 0),
      retentionHours: 72,
      maxHours: MAX_HISTORY_HOURS,
      keptSince: oldest ? oldest.at : (first ? first.at : null),
      archivedRounds: this.archive.rounds.length,
      archivedEvents: this.archivedEventCount,
      measurements: this.archive.points.length,
      durable: this.writable && !!this.file,
      archiveDurable: this.archiveWritable && !!this.archiveFile,
    };
  }
}
