/* HaTi-Mapper — tripwires.
 *
 * The dashboard shows everything, all the time, which is exactly the problem:
 * the owner has to remember to look, and to know what to look for. These are
 * the things they can decide once — "tell me the moment a door opens that
 * needs no login" — and then stop thinking about.
 *
 * Every rule is evaluated on every scan, against the same snapshots the change
 * log is built from, so nothing here reads anything the dashboard does not
 * already have. Two are armed by default: the two about somebody else being
 * able to reach HaTi's data. The rest are about cost and tidiness, and being
 * nagged about those unasked would only teach the owner to ignore the banner.
 */

/* The rules, in the words the Settings tab uses. `unit` is null for the ones
   that have nothing to set a number on. */
export const RULES = {
  openRoute: {
    title: 'A door opened that needs no login',
    plain: 'Tell me the moment a door opens that needs no login',
    why: 'The most urgent thing that can happen to HaTi without anyone noticing.',
    unit: null,
  },
  publicLink: {
    title: 'A new kind of link opens without a login',
    plain: 'Tell me if a new kind of link starts opening without a login',
    why: 'Share links and the advice portal work this way; a new one is worth knowing about.',
    unit: null,
  },
  fileSize: {
    title: 'A file got too big',
    plain: 'Tell me when any file gets bigger than',
    why: 'Past a certain size a file gets slow and risky to change, for a person and for an AI session alike.',
    unit: 'KB',
  },
  aiRequests: {
    title: 'The live site is making a lot of AI requests',
    plain: 'Tell me if the live site makes more AI requests in a day than',
    why: 'Every one of them costs money. Only checkable when the Mapper can reach the running HaTi.',
    unit: 'a day',
  },
  scanHealth: {
    title: 'The Mapper can no longer read HaTi properly',
    plain: 'Tell me if the Mapper can read less of what it looks for than',
    why: 'The early warning that HaTi moved and these panels are quietly filling up with “not detected”.',
    unit: '%',
  },
};

const kb = b => Math.round(b / 1024);

/* Compare the scan just taken with the one before it and return whatever
   tripped. Each trip carries a `key` so the same finding is not raised over
   and over on every subsequent scan. */
export function evaluateWatch({ prev, next, pulse, rules }) {
  const out = [];
  const rule = name => (rules && rules[name]) || {};
  const on = name => !!rule(name).on;
  const limit = (name, fallback) => Number(rule(name).threshold) || fallback;

  const trip = (name, key, text, immediate) => out.push({
    rule: name,
    key: `${name}:${key}`,
    title: RULES[name].title,
    text,
    at: next.at,
    immediate: !!immediate,
  });

  /* (a) a route that now answers with no login. The dangerous one, and the
     only one that should not wait until morning. */
  if (on('openRoute') && prev) {
    const before = new Set(prev.openRoutes || []);
    for (const r of next.openRoutes || []) {
      if (before.has(r)) continue;
      trip('openRoute', r,
        `${r} now answers without anyone logging in. If that was not deliberate, it is the most urgent thing on this page.`,
        true);
    }
  }

  /* (e) a new kind of link that opens with no session behind it. */
  if (on('publicLink') && prev) {
    const before = new Set(prev.hashRoutes || []);
    for (const h of next.hashRoutes || []) {
      if (before.has(h)) continue;
      trip('publicLink', h, `A new kind of link opens without a login: #${h}.`, true);
    }
  }

  /* (b) a file crossing the size the owner set. Only on the crossing, so a
     file that is already large does not raise this every ten minutes. */
  if (on('fileSize') && prev) {
    const ceiling = limit('fileSize', 100);
    const was = new Map((prev.files || []).map(f => [f.path, f.bytes]));
    for (const f of next.files || []) {
      const before = was.get(f.path);
      if (f.bytes <= ceiling * 1024) continue;
      if (before != null && before > ceiling * 1024) continue;
      trip('fileSize', f.path,
        `${f.path} is now ${kb(f.bytes)} KB, past the ${ceiling} KB you asked to be told about.`);
    }
  }

  /* (c) how much the running HaTi is actually spending on AI today. Only
     answerable when the pulse is reachable; silent otherwise rather than
     assuming the best. */
  if (on('aiRequests') && pulse && pulse.available) {
    const count = pulse.usage && typeof pulse.usage.count === 'number' ? pulse.usage.count : null;
    const ceiling = limit('aiRequests', 150);
    if (count != null && count > ceiling) {
      trip('aiRequests', String(pulse.usage.date || ''),
        `The live HaTi has made ${count} AI requests today, past the ${ceiling} you asked to be told about. Every one of them costs money.`);
    }
  }

  /* (d) the scanner losing its grip. Only on the crossing. */
  if (on('scanHealth') && next.health != null) {
    const floor = limit('scanHealth', 90);
    const wasFine = !prev || prev.health == null || prev.health >= floor;
    if (next.health < floor && wasFine) {
      trip('scanHealth', String(floor),
        `The Mapper can now read only ${next.health}% of what it looks for, below the ${floor}% you asked to be told about. Something in HaTi has probably moved.`);
    }
  }

  return out;
}

/* What the Settings tab needs to draw the section, without it having to know
   any of the wording itself. */
export function describeRules(rules) {
  return Object.entries(RULES).map(([name, meta]) => ({
    name,
    plain: meta.plain,
    why: meta.why,
    unit: meta.unit,
    on: !!(rules && rules[name] && rules[name].on),
    threshold: rules && rules[name] ? rules[name].threshold : null,
  }));
}
