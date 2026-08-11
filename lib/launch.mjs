/* HaTi-Mapper — "am I ready?"
 *
 * Every other panel here answers a question about HaTi. This one answers a
 * question about the owner: is there anything left that would make showing
 * this to someone, or letting real people put real contracts in it, a mistake.
 *
 * Two ideas hold the whole file up.
 *
 * ONE — THERE ARE TWO GATES, NOT ONE SCORE.
 * "Ready to demo" and "ready to go live" are different questions with
 * different answers, and the gap between them is where most first launches
 * fail: the demo went fine, so the thing went live, and nothing that only
 * matters with real customers in it had ever been thought about. So every item
 * below is tagged with the gate it blocks. Demo items block both — you cannot
 * be ready for customers and not ready for a demo.
 *
 * TWO — THE NEEDLE CANNOT LIE.
 * A percentage is a flatterer. Twenty-one of twenty-two done reads as 95%,
 * and 95% reads as "basically there" even when the one outstanding item is an
 * address that serves contracts to anyone who asks. So the needle is not free
 * to sit wherever the arithmetic puts it: it is PENNED IN by the gates. While
 * a demo item is outstanding the needle physically cannot reach the demo post,
 * however many other items are ticked, and the same for the live post. The
 * number and the verdict can therefore never disagree, because the number is
 * derived from the verdict rather than the other way round.
 *
 * The same rule that governs the scanner-grip figure governs this one: an
 * alarm that flatters is worse than none. So "the Mapper cannot tell" counts
 * as not done. It is drawn differently — amber, with the reason — because
 * "can't tell" and "no" want different actions from the reader, but neither
 * one opens a gate.
 *
 * WHO ANSWERS EACH ITEM. Some of these the Mapper can settle by itself from
 * the scan, the pulse and its own settings; those are marked `mapper` and no
 * tick box is drawn, because a box you can tick for something measurable is
 * an invitation to lie to yourself. The rest are things no dashboard can see
 * — whether a stranger got through the product, whether the code is on your
 * laptop — and those are marked `you`, carry a tick box, and carry the steps
 * to actually do them.
 *
 * TICKS GO STALE. A backup taken in March is not a backup. A demo walked
 * through six weeks ago is not a rehearsal. Items where that is true carry
 * `staleAfterDays`, and a tick older than that stops counting and says so.
 * This is the difference between a checklist and a list of things you once
 * did.
 */

const DAY = 24 * 60 * 60 * 1000;

/* Where the two posts sit on the needle's track, as percentages. They are
   positions on a dial, not thresholds anything is compared against — nothing
   in here ever asks "is the score above 45?". The gates are decided by the
   outstanding items and the needle is placed afterwards. */
export const DEMO_MARK = 45;
export const LIVE_MARK = 85;

/* ------------------------------------------------------------------ groups */

export const GROUPS = [
  {
    id: 'truth',
    title: 'Can you trust this page?',
    blurb: 'Everything else on this checklist is read off the Mapper. If the Mapper cannot see HaTi properly, the rest of it is decoration.',
  },
  {
    id: 'safe',
    title: 'Is anything open that should not be?',
    blurb: 'The failures that end a business rather than annoy a customer. These are worth being pedantic about exactly once.',
  },
  {
    id: 'yours',
    title: 'Is your work actually yours?',
    blurb: 'Whether you could rebuild this if an account was closed, a laptop died, or a bad deploy went out on a Friday.',
  },
  {
    id: 'money',
    title: 'Can this surprise you with a bill?',
    blurb: 'HaTi calls a paid AI service on someone else\'s behalf. That is a tap, and a tap wants a stop.',
  },
  {
    id: 'real',
    title: 'Has anybody but you used it?',
    blurb: 'You cannot test your own product. You know where not to click.',
  },
  {
    id: 'promise',
    title: 'What you are promising people',
    blurb: 'A contract platform holds documents that matter. People will ask what happens to them. Have the answer before they ask, not after.',
  },
];

/* ------------------------------------------------------------------- items */

/* `check` returns { state, detail } where state is 'done' | 'open' | 'unknown'.
   It is only ever called for `how: 'mapper'` items. `detail` is a full
   sentence in plain English, shown under the item either way — the reason it
   passed is as worth reading as the reason it did not. */

export const ITEMS = [
  /* ---------------------------------------------------------------- truth */
  {
    id: 'real-hati',
    group: 'truth',
    gate: 'demo',
    how: 'mapper',
    title: 'The Mapper is reading the real HaTi',
    why: 'The verification suite can run against a stand-in repository when the real one is out of reach. A stand-in passes every check and tells you nothing about your product.',
    check(ctx) {
      if (!ctx.scan) return { state: 'unknown', detail: 'No scan has finished yet, so there is nothing to say either way.' };
      if (ctx.scan.fixture) return { state: 'open', detail: 'This scan read the test stand-in, not HaTi. Every number on this dashboard describes a fake repository.' };
      return { state: 'done', detail: 'The last scan read ' + (ctx.scan.repo || 'HaTi') + ' itself.' };
    },
  },
  {
    id: 'scan-grip',
    group: 'truth',
    gate: 'live',
    how: 'mapper',
    title: 'The Mapper can still read most of what it looks for',
    why: 'The panels are built by matching patterns against code someone is free to change. When they stop matching, nothing breaks loudly — the panels quietly fill with "not detected" and still look fine.',
    check(ctx) {
      const h = ctx.scan && ctx.scan.health;
      if (!h || h.percent == null) return { state: 'unknown', detail: 'The scan did not produce a grip figure.' };
      if (h.percent >= 90) return { state: 'done', detail: 'The scanner read ' + h.percent + '% of what it looks for. Above 90% the panels can be taken at face value.' };
      return {
        state: 'open',
        detail: 'The scanner read only ' + h.percent + '% of what it looks for, with ' + h.warnings +
          ' thing' + (h.warnings === 1 ? '' : 's') + ' it could not work out. Some of what you are reading may be out of date. The full list is under the gear.',
      };
    },
  },
  {
    id: 'knows-live',
    group: 'truth',
    gate: 'live',
    how: 'mapper',
    title: 'The Mapper can see the running HaTi',
    why: 'Without it, nothing on this dashboard is about the thing your customers are using — it is all about code in a repository, which is not the same thing and can differ by weeks.',
    check(ctx) {
      const p = ctx.pulse;
      if (!p) return { state: 'unknown', detail: 'The Mapper has not tried to reach HaTi since it started.' };
      if (p.available) return { state: 'done', detail: 'HaTi answered the Mapper\'s read-only endpoint.' };
      return { state: 'open', detail: p.reason || 'HaTi is not answering the Mapper.' };
    },
  },
  {
    id: 'in-sync',
    group: 'truth',
    gate: 'live',
    how: 'mapper',
    title: 'What is deployed is the code you think it is',
    why: 'A deploy that silently failed leaves the old version serving customers while every tool you own describes the new one. It is the single most expensive way to be confidently wrong.',
    check(ctx) {
      const d = ctx.pulse && ctx.pulse.drift;
      if (!d || d.state === 'unknown') return { state: 'unknown', detail: (d && d.message) || 'The Mapper cannot compare the two versions right now.' };
      if (d.state === 'match') return { state: 'done', detail: 'The version the scan read and the version HaTi reports running are the same commit.' };
      return { state: 'open', detail: d.message };
    },
  },
  {
    id: 'state-survives',
    group: 'truth',
    gate: 'live',
    how: 'mapper',
    title: 'This dashboard remembers things after a restart',
    why: 'Without a mounted disk, your account, your settings, the change log and its archive are all written somewhere a redeploy replaces. The Mapper would go on working and quietly forget everything it had ever watched.',
    check(ctx) {
      const s = ctx.storage || {};
      if (!s.writable) return { state: 'open', detail: 'Nothing can be written to disk at all, so everything the Mapper learns is held in memory and lost on restart.' };
      if (!s.mounted) return { state: 'open', detail: 'Things are being written to ' + (s.path || 'a folder inside the service') + ', which a redeploy replaces. Attach a persistent disk and set MAPPER_DATA to its mount point.' };
      return { state: 'done', detail: 'Written to ' + (s.path || 'a mounted disk') + ', which survives a redeploy.' };
    },
  },

  /* ----------------------------------------------------------------- safe */
  {
    id: 'no-open-doors',
    group: 'safe',
    gate: 'live',
    how: 'mapper',
    title: 'Nothing answers without a login that should not',
    why: 'This is the one on the list that can end the product rather than embarrass it. An address that serves contract data to anyone who knows the URL is a breach whether or not anybody has found it yet.',
    check(ctx) {
      const routes = (ctx.scan && ctx.scan.public && ctx.scan.public.routes) || [];
      if (!ctx.scan) return { state: 'unknown', detail: 'No scan has finished yet.' };
      if (!routes.length) return { state: 'done', detail: 'Every address in HaTi\'s server checks for a login first.' };
      return {
        state: 'open',
        detail: routes.length + ' address' + (routes.length === 1 ? '' : 'es') + ' answer without a login. Some of those are meant to — a health check, a sign-in page. Open the Doors tab, read all ' +
          routes.length + ', and satisfy yourself about each one. This item is asking whether you have READ them, not whether the number is zero.',
      };
    },
  },
  {
    id: 'doors-checked',
    group: 'safe',
    gate: 'live',
    how: 'mapper',
    title: 'Those open addresses have been knocked on for real',
    why: 'The code\'s promise about an address and what the live site actually does are two different facts, and only one of them is the one your customers meet.',
    check(ctx) {
      const d = ctx.doorCheck;
      if (!d) return { state: 'open', detail: 'The live door check has not been run since this service last started. It is one button on the Doors tab.' };
      const age = Date.now() - new Date(d.at).getTime();
      const surprises = (d.results || []).filter(r => r.verdict && r.verdict !== 'as-expected').length;
      if (surprises) return { state: 'open', detail: 'The last check found ' + surprises + ' address' + (surprises === 1 ? '' : 'es') + ' that did not behave the way the code says. Open the Doors tab.' };
      if (age > 30 * DAY) return { state: 'open', detail: 'The last check was more than a month ago. Run it again — the code has moved since.' };
      return { state: 'done', detail: 'Checked ' + Math.max(1, Math.round(age / DAY)) + ' day' + (Math.round(age / DAY) === 1 ? '' : 's') + ' ago, and every address behaved the way the code says it should.' };
    },
  },
  {
    id: 'no-high-gaps',
    group: 'safe',
    gate: 'live',
    how: 'mapper',
    title: 'Nothing your own documents call urgent is still outstanding',
    why: 'The things most likely to bite you on day one are usually already written down by the person who built it. They just were not ranked, so nobody read them in order.',
    check(ctx) {
      const g = ctx.scan && ctx.scan.gaps;
      if (!g) return { state: 'unknown', detail: 'No scan has finished yet.' };
      if (!g.ranked) {
        return {
          state: 'unknown',
          detail: 'Nothing in HaTi\'s documents states a severity, so the Mapper cannot rank the ' + (g.gaps || []).length +
            ' outstanding item' + ((g.gaps || []).length === 1 ? '' : 's') + ' it found. Start a bullet in HaTi\'s README or SECURITY.md with [high], [medium] or [low] and the next scan will rank them.',
        };
      }
      const high = (g.severityCounts && g.severityCounts.high) || 0;
      if (high) return { state: 'open', detail: high + ' item' + (high === 1 ? '' : 's') + ' marked [high] in HaTi\'s own documents are still outstanding. They are at the top of the "Not finished" list.' };
      return { state: 'done', detail: 'Nothing marked [high] is outstanding.' };
    },
  },

  /* ---------------------------------------------------------------- yours */
  {
    id: 'code-on-disk',
    group: 'yours',
    gate: 'demo',
    how: 'you',
    staleAfterDays: 30,
    title: 'A copy of the code is on your own computer',
    why: 'GitHub is not a backup — it is one company holding one copy, under one account, subject to one password and one set of terms. A locked account, a mis-clicked "delete repository", or a billing lapse takes it with no warning and no undo. A copy on a machine you physically own is the only copy nobody else can revoke.',
    steps: [
      'Install Git for your computer from git-scm.com if you have not already.',
      'Make a folder you will remember — Documents/HaTi is fine.',
      'Open Terminal (Mac) or Git Bash (Windows) in that folder.',
      'Run: `git clone https://github.com/youngmbg21-cmyk/mkataba-clm.git`',
      'Run the same for this dashboard: `git clone https://github.com/youngmbg21-cmyk/HaTi-Mapper.git`',
      'To refresh either copy later, go into its folder and run: `git pull`',
      'Do this again roughly once a month, and always before anything risky.',
    ],
  },
  {
    id: 'data-on-disk',
    group: 'yours',
    gate: 'live',
    how: 'you',
    staleAfterDays: 7,
    title: 'A copy of the live data is on your own computer',
    why: 'This is the copy the code is not. Cloning the repository saves what the product IS; it saves nothing about what is IN it. Every contract, account and signature your customers create lives in the database on the host, and nothing in GitHub has ever seen it. If that database is lost, a perfect copy of the code rebuilds an empty product.',
    steps: [
      'Find where HaTi\'s database actually lives — the hosting dashboard, under the database or disk section.',
      'Take a copy of it onto your own machine. If it is Postgres the host will offer a download or a `pg_dump`; if it is a file on a disk, download the file.',
      'Put it in a dated folder — `HaTi-backups/2026-08-11` — so you can always tell which copy is which.',
      'Copy that folder somewhere that is not your laptop as well — an external drive, or a cloud drive that is not the same account as your host.',
      'Repeat weekly. A backup you take once is a souvenir.',
    ],
  },
  {
    id: 'restore-tested',
    group: 'yours',
    gate: 'live',
    how: 'you',
    staleAfterDays: 90,
    title: 'You have put a backup back at least once',
    why: 'An untested backup is a belief, not a backup. Roughly half of them turn out to be empty, truncated or unreadable, and the moment you find that out is the worst possible moment.',
    steps: [
      'Take your most recent data copy.',
      'Load it into somewhere that is not the live site — a second free database, or a copy of the app on your own machine.',
      'Open it and look for a contract you recognise.',
      'If you cannot find one, the backup is not a backup. Fix that before anything else on this page.',
    ],
  },
  {
    id: 'rollback',
    group: 'yours',
    gate: 'live',
    how: 'you',
    title: 'You know how to put yesterday\'s version back',
    why: 'Something will go out that breaks the product. The question is never whether, it is whether getting back takes four minutes or four hours — and you do not want to be learning the answer while customers are watching.',
    steps: [
      'Open your hosting dashboard and find the list of past deploys.',
      'Find the button that puts an earlier one back. On Render it is "Rollback" on a previous deploy.',
      'Do it once now, on purpose, while nothing is wrong.',
      'Write down where that button is, in words, somewhere you will find it in a panic.',
    ],
  },
  {
    id: 'keys-written-down',
    group: 'yours',
    gate: 'live',
    how: 'you',
    title: 'Every account, key and address is written down outside your head',
    why: 'A product is not only its code. It is a domain registrar, a host, a database, an email provider, an AI account and the card paying for them. Any one of those going unreachable stops everything, and none of them are in the repository.',
    steps: [
      'Open a password manager, or a document in a place only you can reach.',
      'List every service HaTi depends on: where the domain is registered, who hosts the site, who holds the database, who sends the email, the Anthropic account.',
      'For each one write the login, and which card pays for it.',
      'Note where `MAPPER_TOKEN`, `RESEND_API_KEY` and the Anthropic key are set, so a replacement can be put in the right place.',
      'Tell one person you trust where this document is.',
    ],
  },

  /* ---------------------------------------------------------------- money */
  {
    id: 'caps-set',
    group: 'money',
    gate: 'live',
    how: 'mapper',
    title: 'The spending caps are the ones you meant',
    why: 'Every AI feature in HaTi is a request someone else can cause you to pay for. A cap is what stands between an enthusiastic customer and a bill you did not agree to.',
    check(ctx) {
      const p = ctx.pulse;
      if (!p || !p.available) return { state: 'unknown', detail: 'The Mapper cannot reach HaTi, so it is reading the caps written in the code rather than the ones actually in force. Those are not always the same.' };
      return { state: 'done', detail: 'The caps on the Money tab are the ones the running HaTi reported, not code defaults.' };
    },
  },
  {
    id: 'spend-tripwire',
    group: 'money',
    gate: 'live',
    how: 'mapper',
    title: 'You will be told before the AI bill runs away',
    why: 'A cap stops the spend. It does not tell you it stopped it, and a feature silently refusing to work for every customer looks exactly like a feature nobody is using.',
    check(ctx) {
      const w = (ctx.prefs && ctx.prefs.watch) || {};
      const rule = w.aiRequests || {};
      if (!ctx.canWatchLiveUsage) return { state: 'unknown', detail: 'This tripwire counts requests on the running HaTi, and the Mapper cannot reach it. Set HATI_URL and a matching MAPPER_TOKEN on both services.' };
      if (!rule.on) return { state: 'open', detail: 'The AI-requests tripwire is off. Turn it on under the gear and set the number of daily requests that would worry you.' };
      return { state: 'done', detail: 'Armed at ' + rule.threshold + ' AI requests a day.' };
    },
  },
  {
    id: 'morning-email',
    group: 'money',
    gate: 'after',
    how: 'mapper',
    title: 'A summary reaches you each morning without you asking',
    why: 'Not a blocker for either gate — a dashboard nobody opens is a dashboard, and this is the thing that makes you open it. Worth having in the first fortnight, when the surprises happen.',
    check(ctx) {
      if (!ctx.email || !ctx.email.configured) return { state: 'open', detail: 'No email provider is configured, so nothing can be sent. Set RESEND_API_KEY.' };
      if (!ctx.email.ownerEmail) return { state: 'open', detail: 'The Mapper has no address to send to. Set MAPPER_OWNER_EMAIL.' };
      if (!(ctx.prefs && ctx.prefs.digestEmail)) return { state: 'open', detail: 'Email is configured but the morning summary is switched off. It is one toggle under the gear.' };
      return { state: 'done', detail: 'Sent to ' + ctx.email.ownerEmail + ' on the first scan after 6am.' };
    },
  },

  /* ----------------------------------------------------------------- real */
  {
    id: 'walked-it',
    group: 'real',
    gate: 'demo',
    how: 'you',
    staleAfterDays: 7,
    title: 'You have walked the whole demo yourself, on the live address',
    why: 'Not on your laptop, not on a staging copy — on the address you are going to type in front of somebody. The difference between those two is where demos die.',
    steps: [
      'Open the real, public address in a browser window that is not signed in — a private window.',
      'Do the entire path you plan to show, start to finish, without skipping the boring bits.',
      'Time it. If it takes longer than the slot you have, cut something now rather than in the room.',
      'Do it a second time. The second run is the one that finds what the first run got lucky on.',
    ],
  },
  {
    id: 'phone',
    group: 'real',
    gate: 'demo',
    how: 'you',
    staleAfterDays: 30,
    title: 'You have opened it on a phone',
    why: 'Somebody will pull it up on a phone within an hour of you showing it. If it is unusable there, that is the impression that survives the meeting.',
    steps: [
      'Open the live address on your own phone.',
      'Sign in, and try the one thing you most want people to do.',
      'You are not looking for perfect. You are looking for "nothing is cut off, and I can finish the job".',
    ],
  },
  {
    id: 'break-plan',
    group: 'real',
    gate: 'demo',
    how: 'you',
    title: 'You know what you say when it breaks in front of someone',
    why: 'It will do something unexpected at least once. An owner who says "that\'s the AI step, it takes a moment — here\'s what it produces" keeps the room. An owner who goes quiet and starts clicking loses it.',
    steps: [
      'Decide the one sentence you say when a screen is slow.',
      'Decide what you show if the AI step fails outright — a screenshot of a good run, ready in another tab.',
      'Decide what you do NOT show. Have the tabs you need open before you start and nothing else.',
    ],
  },
  {
    id: 'stranger',
    group: 'real',
    gate: 'live',
    how: 'you',
    staleAfterDays: 90,
    title: 'Someone who has never seen it got through it without your help',
    why: 'You cannot test your own product — you know where not to click. This is the single highest-value hour on this entire page, and the one most often skipped.',
    steps: [
      'Find one person who has never seen HaTi. A friend outside the industry is ideal.',
      'Give them the address and one sentence: "make a contract and send it for signature".',
      'Say nothing else. Do not help. Watch where they stop.',
      'Every place they hesitated is a place a customer will leave.',
      'Fix the worst two before you go live. Write the rest down.',
    ],
  },

  /* -------------------------------------------------------------- promise */
  {
    id: 'data-promise',
    group: 'promise',
    gate: 'live',
    how: 'you',
    title: 'You have written down what happens to a customer\'s contracts',
    why: 'HaTi holds documents people are legally bound by. The first serious customer will ask where they are kept, who can read them, and how they get them back if they leave. Not having an answer reads as not having thought about it.',
    steps: [
      'Write a short page — half a side is plenty — covering: where contracts are stored, who can see them, how long they are kept, and how a customer gets a copy of everything if they leave.',
      'Say what you actually do today, not what you intend to do. An honest small answer beats an aspirational large one.',
      'Put it where a customer can find it before they ask.',
      'This is a description of your setup, not legal drafting. If you take on a customer with their own compliance requirements, get it looked at properly then.',
    ],
  },
  {
    id: 'support-route',
    group: 'promise',
    gate: 'live',
    how: 'you',
    title: 'There is a way to reach you when it breaks',
    why: 'Something will go wrong for a customer that you cannot see from here. If the only route back to you is the form that is broken, you will find out from a review instead.',
    steps: [
      'Put a real monitored email address somewhere visible in the product.',
      'Make sure it is not routed through HaTi itself — it has to work when HaTi does not.',
      'Decide how fast you intend to answer, and say so. "Within one working day" kept is worth more than "immediately" missed.',
    ],
  },
];

/* ---------------------------------------------------------------- evaluate */

function tickState(item, tick) {
  if (!tick || !tick.done) {
    return { state: 'open', detail: null };
  }
  if (!item.staleAfterDays) {
    return { state: 'done', detail: tick.at ? 'You ticked this on ' + tick.at.slice(0, 10) + '.' : 'You have ticked this.' };
  }
  const ageDays = Math.floor((Date.now() - new Date(tick.at || 0).getTime()) / DAY);
  if (!isFinite(ageDays) || ageDays < 0) {
    return { state: 'done', detail: 'You have ticked this.' };
  }
  if (ageDays > item.staleAfterDays) {
    return {
      state: 'stale',
      detail: 'You ticked this ' + ageDays + ' days ago, and it is only good for ' + item.staleAfterDays +
        '. It has stopped counting — do it again and re-tick it.',
    };
  }
  return {
    state: 'done',
    detail: 'Ticked ' + (ageDays === 0 ? 'today' : ageDays + ' day' + (ageDays === 1 ? '' : 's') + ' ago') +
      '. Good for another ' + (item.staleAfterDays - ageDays) + ' day' + (item.staleAfterDays - ageDays === 1 ? '' : 's') + '.',
  };
}

/* Only 'done' opens a gate. 'stale' and 'unknown' are drawn differently from
   'open' because they want different actions from the reader, but all three
   count the same way here — which is the whole point of the file. */
const isDone = s => s === 'done';

export function evaluateLaunch(ctx) {
  const ticks = (ctx && ctx.ticks) || {};

  const items = ITEMS.map(item => {
    let state, detail;
    if (item.how === 'mapper') {
      let r;
      try { r = item.check(ctx || {}); }
      catch (e) { r = { state: 'unknown', detail: 'The Mapper could not work this one out (' + e.message + ').' }; }
      state = r.state;
      detail = r.detail;
    } else {
      const r = tickState(item, ticks[item.id]);
      state = r.state;
      detail = r.detail;
    }
    return {
      id: item.id,
      group: item.group,
      gate: item.gate,
      how: item.how,
      title: item.title,
      why: item.why,
      steps: item.steps || null,
      staleAfterDays: item.staleAfterDays || null,
      state,
      detail,
      done: isDone(state),
    };
  });

  const byGate = g => items.filter(i => i.gate === g);
  const demoItems = byGate('demo');
  /* A live gate needs its own items AND the demo ones. You cannot be safe for
     customers and unsafe to show to a friendly audience. */
  const liveItems = demoItems.concat(byGate('live'));

  const demoOpen = demoItems.filter(i => !i.done);
  const liveOpen = liveItems.filter(i => !i.done);
  const doneCount = items.filter(i => i.done).length;
  const raw = Math.round((doneCount / items.length) * 100);

  const verdict = demoOpen.length ? 'not-demo' : liveOpen.length ? 'demo' : 'live';

  /* The pen. The needle is placed from the verdict and only then allowed to
     move within it, so the number can never claim something the gates deny. */
  let needle;
  if (verdict === 'not-demo') needle = Math.min(raw, DEMO_MARK - 1);
  else if (verdict === 'demo') needle = Math.min(Math.max(raw, DEMO_MARK + 1), LIVE_MARK - 1);
  else needle = Math.max(raw, LIVE_MARK + 1);

  const nextUp = (demoOpen.length ? demoOpen : liveOpen.length ? liveOpen : items.filter(i => !i.done))
    .slice(0, 3).map(i => ({ id: i.id, title: i.title, how: i.how, state: i.state }));

  return {
    items,
    groups: GROUPS,
    marks: { demo: DEMO_MARK, live: LIVE_MARK },
    needle,
    raw,
    verdict,
    counts: {
      total: items.length,
      done: doneCount,
      demoTotal: demoItems.length,
      demoOpen: demoOpen.length,
      liveTotal: liveItems.length,
      liveOpen: liveOpen.length,
      yours: items.filter(i => i.how === 'you').length,
      cantTell: items.filter(i => i.state === 'unknown').length,
      stale: items.filter(i => i.state === 'stale').length,
    },
    /* One sentence, because the number at the top of a page is only ever read
       alongside the sentence next to it. */
    headline:
      verdict === 'not-demo'
        ? demoOpen.length + ' thing' + (demoOpen.length === 1 ? '' : 's') + ' still stand between you and showing this to someone.'
        : verdict === 'demo'
          ? 'You can demo this. ' + liveOpen.length + ' thing' + (liveOpen.length === 1 ? '' : 's') + ' still stand between you and letting real people put real contracts in it.'
          : 'Everything that blocks a launch is done. Anything left below is worth having, not worth waiting for.',
    nextUp,
  };
}

/* Which ticks the owner is allowed to set — anything not in here is refused
   rather than stored, so a typo cannot quietly create an item that shows up
   nowhere and counts for nothing. */
export const TICKABLE = new Set(ITEMS.filter(i => i.how === 'you').map(i => i.id));
