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
    /* THERE IS NO SCAN YET is not the same fact as A SCAN COULD NOT READ ITS
       OWN VERSION, and saying the second when the first is true is the badge
       telling the owner their setup is broken when it is merely young.

       This is what a fresh page load looks like after a restart: the page asks
       for the scan and the pulse together, the pulse answers in a second and
       the scan takes a minute, so the verdict was being worked out against an
       empty cache every single time. `scanPending` tells the page to ask again
       once the scan has landed rather than leaving a false alarm on screen. */
    if (!scan) {
      return {
        state: 'unknown',
        scanPending: true,
        scannedCommit: null,
        liveCommit,
        behind: null,
        message: 'Can’t tell yet — HaTi is answering, but the Mapper is still reading it for the first time since it restarted.',
      };
    }
    /* The scan's own version comes from its commit fetch, so when that failed
       the failure IS the reason this badge is grey — say it, rather than
       leaving "could not read" to sound like a mystery. The raw error goes in
       the title (hover) and the sentence stays plain. */
    return {
      state: 'unknown',
      scannedCommit: null,
      liveCommit,
      behind: null,
      reason: scan?.commitError || null,
      message: scan?.commitError
        ? 'Can’t tell whether this is what’s live — the scan could not read HaTi’s commit history, so it does not know which version it was reading.'
        : 'Can’t tell whether this is what’s live — this scan could not read which version it was reading.',
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
