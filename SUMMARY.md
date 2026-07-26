# HaTi-Mapper — what shipped

The mockup is now an application. Every number on the page is read from HaTi
on each scan; none of the hardcoded values survived.

## What was built

**One Express service** (`server.mjs`), no build step, vanilla ES modules,
Express as the only runtime dependency — the same stack conventions as HaTi.

- **`GET /api/scan`** downloads the HaTi repository as a single gzipped tarball,
  unpacks it in memory and parses the code-derived panels out of it.
  Cached for ten minutes; `?refresh=1` bypasses the cache.
- **`GET /api/pulse`** calls HaTi's own read-only endpoint server-to-server and
  returns the caps in force and today's usage.
- **`GET /api/changes`** serves the Mapper's own change log.
- **`GET` / `PUT /api/ai/config`** report and set the assistant's key. The key
  itself is never returned — only its last four characters.
- **`POST /api/chat`** runs the assistant's tool loop.
- **`/api/auth/*`** is the login: set up, sign in, sign out, forgotten
  password, reset, change password, sign out everywhere.
- **`GET /api/health`** is a liveness probe and returns nothing else.

Everything above except `/api/auth/status` and `/api/health` requires a
session.

The tar reader (`lib/tar.mjs`) is ~90 lines over Node's built-in `zlib` rather
than a package.

**The Mapper is behind its own login.** The single shared access token that
shipped in the first version was removed, and replaced by a proper account:
email and password, scrypt hashing with a per-account salt, server-side
sessions behind an httpOnly, SameSite=Lax cookie that is Secure whenever the
connection is https, and password reset by a single-use link that expires in
thirty minutes. The shared token and its environment variable are gone
entirely — there is no longer any way in that is not an account.

Every route that returns or changes anything sits behind `requireAuth`.
`/api/auth/status` and `/api/health` are the only two that answer without a
session, and neither returns any data — status says whether an account exists
and whether you are signed in, nothing more. The page fetches nothing until the
server confirms a session.

Two things from the earlier version were kept for their own sake: the rate
limiter, which bounds how hard the routes in front of the login can be hit and
how many repository downloads one session can trigger; and the two-file serving
allow-list, so no secret reaches the browser.

**An assistant and a 72-hour change log were added in a later round**, both
requested after the dashboard shipped.

The assistant is HaTi's Copilot pattern applied to the Mapper's own data: a
tool loop (`lib/chat.mjs`) where the model calls `get_overview`, `get_panel`,
`get_changes`, `search_map` or `get_live_usage`, gets real values back, and
finishes with `deliver_answer` — grounded, with links to the tab that shows it.
Five turns maximum, so a model that never delivers is cut off rather than
looping.

Two things are deliberately different from HaTi's Copilot. Its system prompt is
built around explaining things to someone who does not read code, because that
is the whole point of this tool and an assistant answering in jargon would undo
it. And its tools reach only the scan, the change log and the caps — there is
no tool that can touch HaTi's database, so contract data cannot reach it even
if asked directly.

The key can be pasted into the page, on the Settings tab, or set as
`ANTHROPIC_API_KEY`. **The pasted key wins** — the environment is a fallback
for anyone who prefers it, the same precedence HaTi uses. That is safe because
the page is behind the login: only the signed-in owner can read the key's last
four characters or replace it. A daily ceiling and a rate limit bound what a
runaway loop can spend.

The change log (`lib/history.mjs`) fingerprints each scan and diffs it against
the last, turning differences into sentences: a new screen, a feature that
changed model, an address that started answering without a login, a file that
crossed 60 KB. Kept 72 hours. A scan that finds nothing changed adds nothing,
so the log is a list of events rather than a list of look-ups.

**The front end** is `index.html` plus `app.js`. The single-file version passed
60 KB once the rendering was in it, so the JavaScript was split out as the
brief allows — no bundler, no framework. It renders; it does not analyse. It
shows loading states, an honest progress note for Render's cold start, and
degrades panel by panel rather than breaking.

**The amber banner was rewritten.** The old text gave removal instructions for
a design where the panel lived inside HaTi. It now says what is true: this is a
separate internal service on a private URL, and HaTi's contribution is one
read-only numbers endpoint that is switched off by clearing `MAPPER_TOKEN`.

**One CSS bug was fixed rather than reproduced.** The mockup's weight bars
never rendered: `.bar .track` is blockified because it is a grid item, but
`.bar .fill` inside it is a plain inline span, so its `width` and `height` were
ignored and every bar showed an empty track. Adding `display:block` to `.fill`
is the whole fix. The brief says not to redesign the mockup, and this is not a
redesign — a bar chart with no bars is the design failing to render.

**The HaTi change** is on branch `claude/new-session-5b3551` in
`mkataba-clm`, unmerged, one commit: `GET /api/pulse` plus a README section.
It is not registered at all unless `MAPPER_TOKEN` is set, requires that token
as a bearer credential, is `GET`-only, rate limited, carries no CORS headers,
logs every call, and returns caps, a count, a boolean, a mode and a commit
hash — nothing else. Nothing else in HaTi was touched.

## Verification

`npm run verify` drives the real front end with the pre-installed Chromium
against a real server. **97 checks, 0 failures**, covering all eight points:

| | Result |
|---|---|
| 1. Headline counts match the payload arrays | All six tiles |
| 2. Eight panels render with real data | None empty, loading, erroring, or showing a mockup value |
| 3. Each "what breaks what" item highlights and explains | Every hand-written item × 3 checks |
| 4. Console errors | Zero from the app |
| 5. What is exposed | Nothing is readable without a session; no source file servable; neither served file carries a secret |
| 6. HaTi unreachable → seven panels fine, spend degrades | The whole run has no HaTi |
| 7. Nothing sensitive in either payload | 9 patterns: emails, keys, tokens, money, names |
| 8. Cold scan cost | One tarball download, well under the request ceiling |

Two notes on how those were run:

- **The one console error the test does not count** is the Google Fonts
  stylesheet, which this sandbox cannot reach. It is classified as an external
  asset failure and printed separately rather than silently dropped. The page
  renders correctly without it — every font stack falls back to a system face.
  Nothing in the app's own code logs an error.
- **The live HaTi path was tested separately** from the headless run, because
  the run deliberately has no HaTi in order to prove check 6. Started with
  `MAPPER_TOKEN` set, HaTi returned real caps and usage through the Mapper, and
  logged `[pulse] served to …`. Wrong token, missing token, unset token and
  unreachable host each produce a distinct, plain message and no crash.

---

## What the scan could not derive reliably, and why

Each of these is marked "not detected" on the page rather than filled in.

**Custom value streams.** `js/templates.js` merges user-created streams into
`FOLDERS` from `localStorage`, so they exist only in an individual user's
browser and never reach the server. No amount of source reading can enumerate
them. The panel shows the six built-in streams and states why that is the whole
list. The mockup's "Logistics · custom" chip could not be reproduced honestly
and was not faked.

**Severity on the "Not finished" panel.** The brief said to use severity where
a source states it. None of the sources does — not the README, not
`SECURITY.md`, not the code. So no severity is shown, the dots are neutral, and
the panel says the ordering is source order, not a ranking. This is the most
visible difference from the mockup, which had confident red/amber/grey dots.

**A commit's areas**, when GitHub's per-commit file list cannot be fetched.
Best-effort by design: a commits failure never takes the scan down, and the
seven source-derived panels do not depend on it.

**Two files are hand-maintained rather than derived**, both validated against
the source on every scan, with stale entries surfaced as warnings on the page:

- `data/dependencies.js` — the "what breaks what" map, as the brief specifies.
  Seeded from `js/versioning.js`, `js/core.js`, `js/views/contract.js` and
  `js/views/portal.js`; the mockup's version carried over and anchored to real
  identifiers. Every subsystem's file and proof identifier, and every field an
  item names, is checked to still exist. Currently zero warnings.
- `data/copy.js` — the plain-English sentences. **This is a second
  hand-maintained file the brief did not name, and it is a deliberate
  deviation.** "What a person does here" is a judgement of the same kind as the
  dependency map; deriving it from function names would produce exactly the
  developer-speak the tool exists to avoid. Everything structural about a
  screen or feature — label, module, size, render function, tier, model, cap,
  callers — is derived. Only the sentence is written, and a screen or feature
  with no entry renders "not detected" rather than silently blank.

---

## What the scan turned up about HaTi

Worth knowing. All of these are derived, not asserted, and visible on the page.

**1. `/api/ai/search` is unreachable from the front end.** The endpoint exists,
is rate limited, tagged for spend, and calls Anthropic on the fast tier — but
nothing in `js/` calls `api('ai/search')`. The register's search box calls
`api('search')`, the SQL full-text route in `js/views/register.js:652`, which
is a different thing. So there is a paid endpoint with no caller. Either the UI
that used it was removed, or it was never wired up. Worth deciding whether to
wire it or delete it; an unreferenced AI endpoint is still an open door that
costs money if anything ever finds it.

**2. Twenty-four names are published on `window` and referenced nowhere else.**
Including `buildGraph`, `scanPortfolio`, `riskScore` and `openPartyModal` from
`views/intelligence.js`, `familyOf` / `isParent` / `isChild` from `family.js`,
and `contractObligations` / `overdueObligationCount` from `obligations.js`.
Each appears exactly once outside the export blocks — its own declaration.
Check before assuming any is load-bearing; several look like the remains of
features that moved.

**3. There are no TODO, FIXME, HACK or XXX markers anywhere.** Zero across all
36 source files. Unusual for a codebase this size, and it means the "Not
finished" panel is entirely documentation-driven. Good discipline, but it also
means the code carries no in-place record of known rough edges — the README and
`SECURITY.md` are the only places that knowledge lives.

**4. The product is bigger than the mockup assumed.** 14 screens (not 13 — the
advice portal at `#advice` is a screen in its own right), 9 AI features (not 6),
15 database tables (not 7), and 14 server routes with no `auth` middleware (not
4 public things). Growth like that is exactly what this panel is for.

**5. `#reset=` is a third public hash route.** Handled in `js/app.js` before any
session is established, alongside `#share=` and `#advice=`. The mockup listed
two. It consumes a single-use expiring token, so it is defensible — but it
belongs on the list.

**6. The settings-blob problem is confirmed, and it is worse than "fine at two
templates."** `customTemplates` is written inside the `appSettings` record at
`server/server.js:1082`, *and* `PUT /api/settings` writes the whole record back
from `req.body` on every save. So every settings change rewrites every custom
template in full, and the dedicated `PUT /api/settings/templates` route that
merges properly is only one of the two write paths.

**7. `server/server.js` is now the largest file in the repository** at 166 KB,
having passed `views/contract.js` (158 KB). Eight files are over the 60 KB line.
`views/contract.js` carries two separately-bannered jobs and 70 exported names;
`views/intelligence.js` carries three bannered sections in 67 KB.

**8. The OCR rate limit is ten times the light limit** — `aiRateOcr` defaults to
400 per 15 minutes against 40 for other light features. That is per page rather
than per document, so it may be deliberate, but it is the loosest cap in the
system and it is not surfaced in the caps table that Team & Settings shows.

---

## Nothing else in HaTi was changed

The brief asked that nothing beyond `/api/pulse` and its README note be touched
in `mkataba-clm`, and nothing was. Findings 1, 2, 6 and 8 above all look like
things worth fixing, and none of them was fixed — they are reported here and on
the dashboard instead, which is where the brief puts them.
