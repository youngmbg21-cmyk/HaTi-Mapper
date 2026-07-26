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

/* The commit list, if the fixture ships one. Shaped like the GitHub commits
   API plus the `_files` list fetchCommits() adds, so scanChanges() reads it
   unchanged. Missing is fine — the commit panel already degrades. */
function readCommits(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '_commits.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[fixture] _commits.json could not be read:', e.message);
    return null;
  }
}

export function readFixture(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) throw new Error(`HATI_FIXTURE points at ${root}, which does not exist.`);
  const files = walk(root, '', new Map());
  files.delete('_commits.json');
  return { files, commits: readCommits(root) };
}

export const FIXTURE_WARNING =
  'This scan read a local stand-in for HaTi (HATI_FIXTURE is set), not the real repository. ' +
  'Nothing on this page describes the live product.';
