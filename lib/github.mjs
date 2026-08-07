/* HaTi-Mapper — the GitHub read layer.
 *
 * Two things come from GitHub: the repository tarball (one request, unpacked
 * in memory) and the recent commit history. Everything else is parsed out of
 * the tarball locally, so a whole scan costs a handful of requests rather than
 * the hundreds a file-by-file walk of the contents API would take.
 *
 * GITHUB_TOKEN should be a fine-grained personal access token scoped to read
 * that one repository and nothing else. Unauthenticated GitHub allows 60
 * requests an hour; authenticated allows 5,000.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { untar, stripRoot } from './tar.mjs';

const gunzip = promisify(zlib.gunzip);

const API = 'https://api.github.com';

/* Every request goes through here so the request count is honest and the
   token is applied in exactly one place. */
function makeClient(token) {
  let requests = 0;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'HaTi-Mapper',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function raw(url, accept) {
    requests++;
    const res = await fetch(url, { headers: accept ? { ...headers, Accept: accept } : headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GitHub ${res.status} for ${url.replace(API, '')}${body ? ': ' + body.slice(0, 200) : ''}`);
      err.status = res.status;
      err.rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
      throw err;
    }
    return res;
  }

  return {
    get requests() { return requests; },
    json: async (path) => (await raw(API + path)).json(),
    buffer: async (path) => Buffer.from(await (await raw(API + path)).arrayBuffer()),
  };
}

/* One request: the whole repository as a gzipped tarball, unpacked in memory.
   Returns { files, commit }: a Map of repository-relative path -> Buffer, and
   the commit the tarball was cut from.

   The commit comes from the tarball's own root directory, which GitHub names
   "owner-repo-<sha>". It used to be thrown away and the version read from the
   commit-history fetch instead — twenty-odd requests later and the first place
   a rate limit lands. So whenever the history fetch failed, the whole "is this
   what's live?" badge went grey over a fact this request had already carried. */
export async function fetchRepoFiles(client, repo, ref) {
  const tgz = await client.buffer(`/repos/${repo}/tarball/${ref}`);
  const tar = await gunzip(tgz);
  const raw = untar(tar);
  const { files, root } = stripRoot(raw);
  const m = /-([0-9a-f]{7,40})$/i.exec(root || '');
  return { files, commit: m ? m[1].slice(0, 7).toLowerCase() : null };
}

/* Recent commits. The list itself is one cheap call; the per-commit file lists
   are separate calls, so they are fetched with bounded concurrency and are
   strictly best-effort — if any of them fail the commit still appears, just
   without its "areas touched". */
export async function fetchCommits(client, repo, ref, count = 20) {
  const list = await client.json(`/repos/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${count}`);

  const detailed = new Array(list.length);
  const queue = list.map((c, i) => ({ c, i }));
  const workers = Array.from({ length: 5 }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      let files = null;
      try {
        const full = await client.json(`/repos/${repo}/commits/${job.c.sha}`);
        files = (full.files || []).map(f => f.filename);
      } catch (_) { /* best effort — areas fall back to "not detected" */ }
      detailed[job.i] = { ...job.c, _files: files };
    }
  });
  await Promise.all(workers);

  return detailed;
}

export { makeClient };
