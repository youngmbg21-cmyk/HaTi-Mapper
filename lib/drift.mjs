/* HaTi-Mapper — "is this what's live?"
 *
 * The dashboard reads HaTi's source from GitHub. The site your customers use
 * is whatever was last deployed. Those are not always the same thing, and the
 * gap between them is the one way this tool could quietly mislead: every panel
 * would be accurate about code that nobody is running.
 *
 * Both numbers are already available — the scan knows which commit it read,
 * and HaTi's pulse reports the commit the running deployment was built from —
 * so this compares them and says which of three things is true, in a sentence.
 *
 * It never guesses. If the live version cannot be reached, the answer is
 * "can't tell", not "probably fine".
 */

/* Commit hashes arrive at different lengths: the scan shortens to seven,
   HaTi's pulse may send the full forty. Compare the common prefix. */
const short = h => String(h || '').trim().toLowerCase().slice(0, 7) || null;

/* How far behind the running deployment is, when that is knowable. The scan
   carries the most recent commits, newest first, so the live commit's position
   in that list IS the number of commits it is behind. Not in the list means
   the deployment is older than the window, or on another branch — either way
   the honest answer is "a different version", with no number. */
function commitsBehind(scan, liveCommit) {
  const list = (scan?.changes || []).map(c => short(c.sha));
  const at = list.indexOf(liveCommit);
  return at === -1 ? null : at;
}

export function driftVerdict(scan, pulse) {
  const scannedCommit = short(scan?.commit);
  const liveCommit = pulse && pulse.available ? short(pulse.version) : null;

  if (!liveCommit) {
    return {
      state: 'unknown',
      scannedCommit,
      liveCommit: null,
      behind: null,
      message: 'Can’t tell whether this is what’s live — HaTi isn’t answering right now.',
    };
  }

  if (!scannedCommit) {
    return {
      state: 'unknown',
      scannedCommit: null,
      liveCommit,
      behind: null,
      message: 'Can’t tell whether this is what’s live — this scan could not read which version it was reading.',
    };
  }

  if (scannedCommit === liveCommit) {
    return {
      state: 'match',
      scannedCommit,
      liveCommit,
      behind: 0,
      message: 'You’re looking at the code that’s live.',
    };
  }

  const behind = commitsBehind(scan, liveCommit);
  return {
    state: 'different',
    scannedCommit,
    liveCommit,
    behind,
    message: behind != null
      ? `The live site is running a different version than you’re reading — ${behind} commit${behind === 1 ? '' : 's'} behind.`
      : 'The live site is running a different version than you’re reading.',
  };
}
