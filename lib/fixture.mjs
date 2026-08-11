/* HaTi-Mapper — reading HaTi's source from a directory instead of GitHub.
 *
 * This exists for one reason: the verification suite has to be able to run
 * where the real HaTi repository cannot be downloaded — a machine with no
 * network, a token that has not been issued yet, or a sandbox whose policy
 * only allows this repository. Without it, every check in `npm run verify`
 * fails for a reason that has nothing to do with the Mapper's own code.
 *
 * It is off unless `HATI_FIXTURE` names a directory. In normal running that
 * variable is unset, the tarball path in lib/github.mjs is the only way source
 * reaches the scanner, and this file is never touched. When it IS set, the
 * scan payload is marked `fixture: true` and carries a warning saying so, so a
 * dashboard reading a stand-in can never be mistaken for one reading HaTi.
 *
 * `test/fixture/` holds the stand-in itself: a small tree shaped like HaTi —
 * a nav, view modules, an Express server with routes, tables and AI features,
 * a README and a SECURITY.md — with no real content of any kind in it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* Every file under `dir`, keyed by its path relative to `dir` — the same shape
   the tarball reader returns, so the scanner cannot tell the difference. */
function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(abs, rel, out);
    else out.set(rel, fs.readFileSync(abs));
  }
  return out;
}

/* A fixture date may be written as `midnight+<n>m` instead of a timestamp,
   meaning "n minutes after today's midnight". Some of what the dashboard shows
   is about *last night* — the morning summary above all — and a stand-in with
   only fixed dates in it can never reach that state, so those panels would go
   unexercised or would depend on the clock. Resolved here, at read time, and
   only ever for a fixture: nothing in the tarball path can produce one. */
function resolveDate(value, now) {
  const m = typeof value === 'string' && value.match(/^midnight\+(\d+)m$/);
  if (!m) return value;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + Number(m[1]) * 60 * 1000).toISOString();
}

/* The commit list, if the fixture ships one. Shaped like the GitHub commits
   API plus the `_files` list fetchCommits() adds, so scanChanges() reads it
   unchanged. Missing is fine — the commit panel already degrades. */
function readCommits(dir, now = new Date()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '_commits.json'), 'utf8'));
    for (const c of raw) {
      const author = c?.commit?.author;
      if (author) author.date = resolveDate(author.date, now);
    }
    return raw;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[fixture] _commits.json could not be read:', e.message);
    return null;
  }
}

/* A real checkout has no `_commits.json` — it has a git history instead, which
 * is the same information in a different envelope. Read it into the shape
 * fetchCommits() returns, so the change log, the morning summary and the
 * numbered list of saves can be exercised against a real repository rather
 * than only against the stand-in's hand-written pair. Best effort throughout:
 * a directory that is not a checkout, or a git that will not run, simply
 * yields no commits, which is a state every one of those panels already
 * handles. `_commits.json` still wins where a fixture ships one, because that
 * is a deliberately shaped history and this is whatever happens to be there.
 */
function readGitLog(dir, count = 20) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const run = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 20000 });
  try {
    const SEP = '';
    const raw = run(['log', `-${count}`, `--pretty=format:%H${SEP}%an${SEP}%aI${SEP}%s`]);
    return raw.split('\n').filter(Boolean).map(line => {
      const [sha, name, date, ...rest] = line.split(SEP);
      let files = null;
      try {
        files = run(['show', '--name-only', '--pretty=format:', sha]).split('\n').map(s => s.trim()).filter(Boolean);
      } catch (_) { /* best effort — areas fall back to "not detected" */ }
      return { sha, commit: { message: rest.join(SEP), author: { name, date } }, _files: files };
    });
  } catch (e) {
    console.warn('[fixture] the checkout\'s git log could not be read:', e.message);
    return null;
  }
}

export function readFixture(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) throw new Error(`HATI_FIXTURE points at ${root}, which does not exist.`);
  const files = walk(root, '', new Map());
  files.delete('_commits.json');
  return { files, commits: readCommits(root) || readGitLog(root) };
}

export const FIXTURE_WARNING =
  'This scan read a local stand-in for HaTi (HATI_FIXTURE is set), not the real repository. ' +
  'Nothing on this page describes the live product.';
