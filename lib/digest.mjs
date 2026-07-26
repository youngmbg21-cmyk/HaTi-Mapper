/* HaTi-Mapper — "what did last night's session do?"
 *
 * The owner runs unattended Claude Code sessions overnight and asks the same
 * question every morning. The change log already holds the answer, but it
 * holds it as a stream of individual events across however many scans ran
 * while they were asleep. This groups that stream into one report: what moved,
 * in which area, how far the scanner's grip slipped, and which commits landed.
 *
 * It derives everything from the change log and the scan payload. It reads
 * nothing new, reaches nothing, and carries nothing beyond the same names,
 * paths, counts and byte sizes the snapshots already hold — which is what
 * makes it safe to put in an email.
 */

/* The window a digest covers. "Since midnight" is the default because that is
   the question actually being asked: what happened while I was asleep. */
export function windowStart(period, now = new Date()) {
  if (period === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (period === '72h') return new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}

export const PERIOD_LABEL = {
  midnight: 'since midnight',
  '24h': 'in the last 24 hours',
  '72h': 'in the last three days',
};

/* The areas, in the order they matter to someone deciding what to look at
   first. An open door beats a bigger file. */
const AREAS = [
  ['public', 'Doors that need no login'],
  ['ai', 'What it costs to run'],
  ['data', 'Where things are kept'],
  ['screens', 'Screens'],
  ['gaps', 'Known gaps'],
  ['weight', 'File sizes'],
  ['map', 'The Mapper itself'],
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function buildDigest({ rounds, points, scan, period = 'midnight', now = new Date() }) {
  const since = windowStart(period, now);
  const sinceMs = since.getTime();

  const inWindow = (rounds || []).filter(r => new Date(r.at).getTime() >= sinceMs);
  const events = inWindow.flatMap(r => r.events.map(e => ({ ...e, at: r.at, commit: r.commit })));

  const sections = AREAS
    .map(([kind, title]) => ({
      kind,
      title,
      // Highest weight first, so the sentence worth reading is the first one.
      events: events.filter(e => e.kind === kind).sort((a, b) => (b.weight || 1) - (a.weight || 1)),
    }))
    .filter(s => s.events.length);

  /* How the scanner's grip changed over the window. Both ends have to be
     inside it, or the delta would be measuring the wrong thing. */
  const within = (points || []).filter(p => new Date(p.at).getTime() >= sinceMs && p.health != null);
  const health = within.length >= 2
    ? { from: within[0].health, to: within[within.length - 1].health, delta: within[within.length - 1].health - within[0].health }
    : (within.length === 1 ? { from: null, to: within[0].health, delta: null } : null);

  /* Bytes are already in the measurements, so "the whole thing grew" is
     answerable without going back to the snapshots. */
  const bytes = (points || []).filter(p => new Date(p.at).getTime() >= sinceMs);
  const growth = bytes.length >= 2 ? bytes[bytes.length - 1].bytes - bytes[0].bytes : null;

  const commits = (scan?.changes || [])
    .filter(c => c.date && new Date(c.date).getTime() >= sinceMs)
    .map(c => ({ sha: c.sha, subject: c.subject, date: c.date, areas: c.areas }));

  const serious = events.filter(e => (e.weight || 1) >= 3).length;
  const label = PERIOD_LABEL[period] || PERIOD_LABEL.midnight;

  let headline;
  if (!events.length && !commits.length) {
    headline = `Nothing has moved in HaTi ${label}.`;
  } else {
    const bits = [];
    if (events.length) bits.push(plural(events.length, 'change', 'changes') + ' across ' + plural(sections.length, 'area', 'areas'));
    if (commits.length) bits.push(plural(commits.length, 'commit', 'commits'));
    headline = `${bits.join(' and ')} ${label}.` +
      (serious ? (serious === 1 ? ' One of them is worth looking at first.' : ` ${serious} of them are worth looking at first.`) : '');
  }

  return {
    period,
    label,
    since: since.toISOString(),
    until: now.toISOString(),
    quiet: !events.length && !commits.length,
    headline,
    eventCount: events.length,
    seriousCount: serious,
    scanCount: inWindow.length,
    sections,
    health,
    bytesGrown: growth,
    commits,
  };
}

/* The same report as plain text, for the email. No markup, no links, nothing
   beyond what the dashboard already shows. */
export function digestText(digest, opts = {}) {
  const lines = [];
  lines.push('HaTi — what changed ' + digest.label);
  lines.push('');
  lines.push(digest.headline);
  lines.push('');

  for (const s of digest.sections) {
    lines.push(s.title);
    for (const e of s.events) lines.push('  - ' + e.text);
    lines.push('');
  }

  if (digest.health) {
    lines.push(digest.health.delta == null
      ? `The scanner could read ${digest.health.to}% of what it looks for.`
      : `The scanner could read ${digest.health.to}% of what it looks for (was ${digest.health.from}%).`);
    lines.push('');
  }

  if (digest.bytesGrown != null && Math.abs(digest.bytesGrown) >= 1024) {
    const kb = Math.round(Math.abs(digest.bytesGrown) / 1024);
    lines.push(`The whole thing ${digest.bytesGrown > 0 ? 'grew' : 'shrank'} by about ${kb} KB.`);
    lines.push('');
  }

  if (digest.commits.length) {
    lines.push('Commits');
    for (const c of digest.commits) lines.push(`  - ${c.subject} (${c.sha})`);
    lines.push('');
  }

  if (opts.link) {
    lines.push('The full picture is on the dashboard: ' + opts.link);
    lines.push('');
  }
  lines.push('You are getting this because morning summaries are switched on in the Mapper\'s Settings. Turn them off there.');
  return lines.join('\n');
}
