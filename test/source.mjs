/* Which copy of HaTi's source this test run can actually read.
 *
 * Every test file starts a real server, and every one of them needs a scan to
 * succeed before it can assert anything. Normally that means downloading the
 * HaTi repository from GitHub. Where that is not possible — no network, no
 * token, or a sandbox whose policy only allows this repository — the whole
 * suite fails for a reason that has nothing to do with the Mapper.
 *
 * So each run asks GitHub once whether the repository is readable, and falls
 * back to `test/fixture/` if it is not. The answer is printed at the top of
 * the run, and the fixture path is never chosen silently.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = path.join(__dirname, 'fixture');

export async function hatiSource() {
  const repo = process.env.HATI_REPO || 'youngmbg21-cmyk/mkataba-clm';
  const token = (process.env.GITHUB_TOKEN || '').trim();
  let reason = '';

  /* A checkout of the real HaTi, named explicitly. This is how the suite gets
     run against the actual product on a machine that cannot download it —
     which is worth having, because several checks here only ever failed
     against the real repository and passed happily against the stand-in. It
     is never chosen by accident: nothing sets HATI_FIXTURE but a person. */
  const named = (process.env.HATI_FIXTURE || '').trim();
  if (named && named !== FIXTURE_DIR) {
    return { mode: 'checkout', env: { HATI_FIXTURE: named }, note: `reading a local checkout at ${named}` };
  }

  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'HaTi-Mapper-tests',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (r.ok) return { mode: 'live', env: {}, note: `reading the real ${repo}` };
    reason = `GitHub answered ${r.status} for ${repo}`;
  } catch (e) {
    reason = `GitHub could not be reached (${e.message})`;
  }

  return {
    mode: 'fixture',
    env: { HATI_FIXTURE: FIXTURE_DIR },
    note: `${reason} — falling back to the stand-in in test/fixture`,
  };
}

export function announce(source) {
  if (source.mode === 'live') return console.log(`\n[source] ${source.note}`);
  if (source.mode === 'checkout') {
    return console.log(`\n[source] ${source.note}\n[source] Every check below runs against that checkout — the real product, read off disk rather than downloaded.`);
  }
  console.log(`\n[source] ${source.note}\n[source] Every check below still runs; the numbers describe the stand-in, not the live product.`);
}
