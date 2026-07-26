/* HaTi-Mapper — knocking on the doors.
 *
 * "Open to the public" is derived from HaTi's source: a route with no auth in
 * its middleware chain. That is a claim about the code, not about the running
 * site, and the two can differ — a proxy rule, a deploy that never landed, a
 * guard added inside a handler where the scan cannot see it. This checks the
 * claim against reality.
 *
 * It is the only thing in the Mapper that deliberately pokes the live site, so
 * every limit here is deliberate and none of them is negotiable at runtime:
 *
 *   - GET only. A route declared POST, PUT, PATCH or DELETE is never called,
 *     because calling it would write data. It is listed as not checked, with
 *     that reason on screen.
 *   - Never automatic. Only the owner pressing the button starts a check.
 *   - One request at a time, half a second apart, eight seconds each, thirty
 *     requests at most. That is a person knocking, not a scanner sweeping.
 *   - Status codes and a size band only. No response body is read, stored or
 *     shown — this must not become a way to pull HaTi's data through the
 *     Mapper, and the easiest way to guarantee that is never to look.
 */

export const CHECK_CAP = 30;        // requests per check, hard
export const THROTTLE_MS = 500;     // between requests
export const TIMEOUT_MS = 8000;     // per request

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* Decide what will and will not be knocked on, before anything is sent. Split
   out from the knocking itself so the caps can be asserted without a network. */
export function planCheck(routes) {
  const plan = [];
  const skipped = [];

  for (const r of routes || []) {
    const address = `${r.method} ${r.path}`;

    if (MUTATING.has(r.method)) {
      skipped.push({ address, reason: 'not checked: checking would write data' });
      continue;
    }
    if (r.tokenInPath) {
      skipped.push({ address, reason: 'not checked: it needs an unguessable code that only a real recipient has' });
      continue;
    }
    if (plan.length >= CHECK_CAP) {
      skipped.push({ address, reason: `not checked: this check stops at ${CHECK_CAP} requests` });
      continue;
    }
    plan.push(r);
  }

  return { plan, skipped };
}

/* A size band, so "it answered with something substantial" can be said without
   anyone reading what that something was. */
export function sizeBand(bytes) {
  if (bytes == null) return 'unknown';
  if (bytes === 0) return 'empty';
  if (bytes < 1024) return 'tiny';
  if (bytes < 100 * 1024) return 'a page or so';
  return 'large';
}

/* What the code led us to expect from this door, in the owner's words. */
export function expectationFor(route) {
  if (route.servesShell) return 'to hand back the app page, with no data in it';
  if (route.tokenGuarded) return 'to turn us away, because it checks its own secret';
  return 'to answer without asking us to log in';
}

/* Compare what happened with what the code said. Only the status code and the
   size band are considered — that is the whole comparison. */
export function verdictFor(route, outcome) {
  const address = `${route.method} ${route.path}`;
  const base = { address, expected: expectationFor(route), line: route.line };

  if (outcome.unreachable) {
    return { ...base, verdict: 'unreachable', status: null, size: null,
      says: `Could not be reached (${outcome.reason}). That may be the door, or may be the whole site.` };
  }

  const { status, bytes } = outcome;
  const size = sizeBand(bytes);
  const said = { ...base, status, size };

  if (route.tokenGuarded) {
    if (status === 401 || status === 403) {
      return { ...said, verdict: 'as-expected', says: 'Turned us away, exactly as the code says it should.' };
    }
    if (status >= 200 && status < 300) {
      return { ...said, verdict: 'unexpected-data',
        says: `Answered ${status} and sent back ${size} of something, without being given its secret. That is the surprise worth looking at.` };
    }
    return { ...said, verdict: 'as-expected', says: `Answered ${status} and gave nothing away.` };
  }

  if (status === 401 || status === 403) {
    return { ...said, verdict: 'needs-login',
      says: `Asked us to log in (${status}), although the code says it does not. Something in front of it is guarding it.` };
  }
  if (status === 404) {
    return { ...said, verdict: 'missing',
      says: 'Not there at all (404). The code describes a door the live site does not have.' };
  }
  if (status >= 500) {
    return { ...said, verdict: 'error', says: `Answered ${status} — the live site errored rather than answering.` };
  }
  if (status >= 200 && status < 400) {
    return { ...said, verdict: 'as-expected',
      says: `Answered ${status} with ${size}, without asking us to log in — as the code says.` };
  }
  return { ...said, verdict: 'error', says: `Answered ${status}, which is neither an answer nor a refusal.` };
}

/* One sentence for the top of the panel. */
export function summarise(results, skipped) {
  const total = results.length + skipped.length;
  const asExpected = results.filter(r => r.verdict === 'as-expected').length;
  const surprises = results.filter(r => r.verdict !== 'as-expected').length;

  if (!results.length) {
    return `The code says ${total} door${total === 1 ? '' : 's'} are open, and none of them could be knocked on without writing data or a code we do not have.`;
  }
  return `The code says ${total} door${total === 1 ? '' : 's'} are open; ` +
    `${results.length} could be knocked on, ${asExpected} behaved as written` +
    (surprises ? `, and ${surprises} surprised us.` : '.') +
    (skipped.length ? ` The other ${skipped.length} were left alone on purpose.` : '');
}
