# HaTi-Mapper — what shipped

## Waiting on the owner

Everything below is built and verified. These are the things only you can do,
because they need a hosting dashboard or a change to HaTi itself:

- **Set `MAPPER_OWNER_EMAIL` in Render**, and attach a persistent disk — mount
  it at `/var/data` and set `MAPPER_DATA=/var/data`. Without a disk, your
  account, the change log and its archive, your settings and the day's question
  count are all lost on every redeploy.
- **Review and merge HaTi's `/api/pulse` branch** (`claude/new-session-5b3551`
  in `mkataba-clm`) and set a matching `MAPPER_TOKEN` on both services. Until
  then the spend panel shows code defaults, the "is this what's live?" badge
  reads "can't tell", and the AI-request tripwire cannot be checked.
- **Adopt the severity convention in HaTi's documents** if you want the "Not
  finished" list ranked: start a bullet in HaTi's README or `SECURITY.md` with
  `[high]`, `[medium]` or `[low]`. The Mapper side is built and will pick them
  up on the next scan; until a document states one, nothing is ranked and the
  panel says why.
- **Add `RESEND_API_KEY`** if you want the morning summary and the alerts by
  email. Without it the reset link goes to the service log, the morning summary
  is simply not sent, and the alerts appear as banners instead — everything
  degrades rather than breaking, and the Settings tab says which.
- **Set `MAPPER_URL`** (optional) to this dashboard's own address, so emails
  you asked for can link back to it.
- **Add a repository secret named `HATI_SCAN_TOKEN`** if you want the checks
  that now run on every push (W17) to read the real HaTi rather than the
  stand-in. A fine-grained token with read-only Contents permission on
  `mkataba-clm` and nothing else. Without it the workflow still runs every
  check and still passes or fails honestly — it simply says at the top of each
  run that the numbers describe the stand-in. This one is new: it was not in
  the brief, and it comes out of what the build run ran into (W0).


## The July 2026 build run — all seventeen work items

All seventeen items in the build brief were completed, in the order given, one
commit each. **Nothing was abandoned and nothing was left unattempted.**
`npm run verify` passed before every commit; the per-item figures below were
re-measured afterwards by running the suite again at each commit, so they are
readings rather than recollections.

Problems hit along the way — including the ones that were my own mistakes — are
written up in `BUGLOG.md`.

### W0 — The suite could not run at all (unplanned, before W1)

**Shipped.** The build sandbox cannot reach HaTi's repository: its network
policy allows this repository only, and the token in its environment is not a
GitHub credential. Every test file needs a successful scan before it can assert
anything, so rule 4 was unsatisfiable on the first line of the run.
`lib/fixture.mjs` lets the scanner read HaTi's source from a directory instead
of a tarball; `test/fixture/` is a 33-file stand-in shaped like HaTi with no
real content in it; `test/source.mjs` asks GitHub once per run and falls back
only if the answer is no, printing the choice at the top of every run. A scan
that read a fixture marks itself and warns, so a stand-in can never pass for
the live product.

**Deviation.** The brief did not ask for this, and hard rule 3 forbade the
obvious alternative of adding HaTi's repository to the session. The cost is
real and worth naming: **no work item in this run was verified against the live
HaTi.** The checks prove the Mapper's own behaviour — parsers, routes, login,
limits, panels, degradation — against a repository shaped like HaTi. Anything
depending on HaTi's *current* source has not been re-confirmed. Any machine
with a token that can read `mkataba-clm` takes the live path automatically,
with no flag to set. Full write-up in `BUGLOG.md`.

**Verification.** `npm run verify` at `eba02b9`: **215 checks, 0 failures** (131 + 34 + 50).

### W1 — Make the documentation stop lying

**Shipped.** `SUMMARY.md` still described a version with no login and claimed
the environment AI key beat the pasted one; both were false. Those sections
were rewritten, the stale comment in `server.mjs` next to the chat budget that
still denied the login existed went with them, and both documents plus the code
comments were swept for anything else
contradicting observed behaviour. The sweep is now a permanent check rather
than a one-off read: seven sentences that were once true and are now false are
asserted absent from `README.md`, `SUMMARY.md`, `server.mjs`, `app.js` and
three library files, so the same rot cannot set in silently again.

**Deviation.** None.

**Verification.** `npm run verify` at `54b0ff3`: **224 checks, 0 failures** (131 + 36 + 57).

### W2 — Fix rate-limiter identity

**Shipped.** The limiter keyed on the first entry of `x-forwarded-for`, which
any caller can write, so rotating that header bought a fresh bucket and the
login limit was bypassable. `app.set('trust proxy', 1)` plus keying every
limiter and `clientIp()` on Express's derived `req.ip`.

**Deviation.** None, but the test needed more than the brief implies. There is
no way to tell a forged header from a real one without something in front of
the service, so the test starts a stand-in reverse proxy that appends its own
view of the caller the way a real edge does, and drives the Mapper through it.
A caller writing whatever it likes into the header lands in the same bucket as
its real source.

**Verification.** `npm run verify` at `3fb460d`: **229 checks, 0 failures** (131 + 36 + 62).

### W3 — Account-level login backoff

**Shipped.** Ten consecutive wrong passwords on the account close it for
fifteen minutes, wherever the attempts came from, with a plain message naming
the minutes left. A correct password clears the counter, and so does a
completed password reset. The counter lives in `account.json`, so a restart
does not hand an attacker a fresh ten.

**Deviation.** One addition: `LOGIN_LOCK_MINUTES` makes the window
configurable, purely so the test can prove a lock survives a real kill and
restart without a fifteen-minute wait. It defaults to 15 and is not documented
as an owner-facing setting.

**Verification.** `npm run verify` at `cb454b9`: **238 checks, 0 failures** (131 + 36 + 71).

### W4 — Content-Security-Policy header

**Shipped.** `default-src 'none'` and everything opened deliberately from
there: scripts and connections from this origin only, styles from here and
Google Fonts with `'unsafe-inline'` for the `style=""` attributes the existing
markup uses, fonts from `fonts.gstatic.com`, and `frame-ancestors 'none'`. No
external scripts, no images from anywhere. The headless run counts CSP
violations separately from ordinary console errors and asserts zero of both,
on every page it drives.

**Deviation.** None.

**Verification.** `npm run verify` at `11f7a0d`: **243 checks, 0 failures** (136 + 36 + 71).

### W5 — Durable, fair chat budget

**Shipped.** The day's question count is written to `MAPPER_DATA` and read on
boot, degrading to memory with a console warning where the directory is not
writable — the same pattern `Accounts` uses. A question counts against the
budget only after Anthropic answers, so a failure no longer charges the owner
for nothing.

**Deviation.** None.

**Verification.** `npm run verify` at `65b5e29`: **249 checks, 0 failures** (136 + 42 + 71).

### W6 — "Is this what's live?" drift badge

**Shipped.** `lib/drift.mjs` compares the commit the scan read with the commit
HaTi's pulse says is running, and the header carries one line in plain English:
looking at the live code, a different version (with how many commits behind
where the scanned commit list can say), or can't tell because HaTi is not
reachable. The unreachable state is the one the headless run sees, and it is
asserted there; the other two are asserted directly against `driftVerdict`.

**Deviation.** None.

**Verification.** `npm run verify` at `ee17770`: **260 checks, 0 failures** (140 + 42 + 78).

### W7 — Keep history beyond 72 hours

**Shipped.** Events and measurements older than the 72-hour working window are
appended to an archive file in `MAPPER_DATA` rather than dropped, capped at
10,000 events with the oldest going first. `GET /api/changes` accepts ranges up
to 90 days and merges the archive with the live window; the "What changed" tab
gained a 72 hours / 7 days / 30 days / 90 days control, still 72 hours by
default. Nothing beyond the existing snapshot fields is archived — names,
paths, counts and byte sizes only.

**Deviation.** None.

**Verification.** `npm run verify` at `8d5b619`: **276 checks, 0 failures** (144 + 42 + 90).

### W8 — Scan health score

**Shipped.** One number on the overview — *"The scanner could read 96% of what
it looks for"* — counting every fact the scan tries to derive against those
that came back "not detected" or raised a warning. It is deliberately
pessimistic: a warning counts against the score as well as the fact it is
about, because an alarm that flatters is worse than none. It goes into every
snapshot, so a drop is a change-log event and a watchable rule.

**Deviation.** None.

**Verification.** `npm run verify` at `5b5253f`: **286 checks, 0 failures** (148 + 42 + 96).

### W9 — Morning-after session digest

**Shipped.** `lib/digest.mjs` groups the change log and archive into one report
for a window — screens, storage, open doors, gaps, file sizes, the map, spend,
plus the commits from that window and the scan-health delta — and a "Last
night" card at the top of "What changed" renders it in sentences. With
`RESEND_API_KEY` set and the Settings toggle on, the same report is emailed
once a day on the first scan after 6am, carrying nothing beyond
snapshot-class information. Without the key the toggle explains itself and the
card still works.

**Deviation.** None.

**Verification.** `npm run verify` at `946a02b`: **313 checks, 0 failures** (155 + 42 + 116).

### W10 — Watch rules ("tell me if…")

**Shipped.** Five tripwires in `lib/watch.mjs`, each with a plain-English
sentence, a reason, an on/off toggle and where relevant a threshold, stored in
`MAPPER_DATA`: a door opening that needs no login (on by default), a new public
link route (on by default), a file crossing N KB, live AI requests past N, and
scan health dropping below N%. A trip pins a red banner to the top of the
dashboard until dismissed, writes a high-weight event to the change log, and
joins the next digest email — immediately for the open-door rule, which does
not wait for morning. The AI-requests rule says on screen when it cannot be
checked because HaTi is unreachable, rather than sitting there looking active.

**Deviation.** None.

**Verification.** `npm run verify` at `f96bd1c`: **338 checks, 0 failures** (164 + 42 + 132).

### W11 — Alert on repeated scan failure

**Shipped.** Three consecutive failed scans raise exactly one alert — emailed
where `RESEND_API_KEY` is set, and a persistent banner either way — naming when
the Mapper last managed to read HaTi and why it now cannot. Further failures
raise nothing more. A successful scan clears the count, the flag and the
banner, so the next outage alerts again.

**Deviation.** None. The test needed a fourth Mapper pointed at a source
directory that does not exist, with the directory created underneath it
afterwards to prove recovery; nothing was simulated.

**Verification.** `npm run verify` at `e993749`: **350 checks, 0 failures** (164 + 42 + 144).

### W12 — Estimated cost, not just counts

**Shipped.** `data/pricing.js` is a hand-maintained model → price map with an
`asOf` date, validated on every scan exactly as `data/copy.js` is: a model in
use with no entry renders "price not on file" and never a guess, and prices
older than 90 days raise a visible note. Token counts are not available from
the pulse and the pulse was not widened, so each feature's cost is estimated
from its own `max_tokens` cap with the assumption stated on screen and the
label kept honest — a rough ceiling, not a bill. Per-feature, per-window and
per-day figures, with the daily estimate in every snapshot.

**Deviation.** The pricing file deliberately omits models whose price was not
to hand rather than filling them in. That is the file working as designed:
"price not on file" is a visible gap, and a made-up number is not.

**Verification.** `npm run verify` at `cb59860`: **368 checks, 0 failures** (169 + 42 + 157).

### W13 — Gaps: severity and a scoreboard

**Shipped.** `scanGaps` recognises an optional `[high]` / `[medium]` / `[low]`
prefix on a bullet in HaTi's README or `SECURITY.md`, ranks and colours the
panel where one is present, and keeps today's neutral source-order behaviour
and its explanatory note where none is. The tag never appears in the text, and
nothing is ever inferred from wording. Using the W7 archive, the panel also
says how the list has moved — *"3 closed, 1 opened in the last 30 days"* —
counted from tagged change-log events rather than from sentence-matching.

**Deviation.** None. The convention now needs adopting in HaTi's own documents,
which is in the owner list at the top of this file.

**Verification.** `npm run verify` at `ffce70f`: **379 checks, 0 failures** (169 + 42 + 168).

### W14 — Trend lines

**Shipped.** A strip of six sparklines on the overview, drawn from the archive:
everything all together, the biggest single file, doors that need no login,
things not finished, how much the scanner can read, and a day at the caps in
money. Each carries the value it stands at now and one sentence of direction —
*"33% bigger than 90 days ago"* — with movement in the unwelcome direction
coloured as such. Below three readings it says "not enough history yet" and
draws nothing, because a line through one point is a lie. Plain SVG built in
`app.js`; no chart library, and Express is still the only runtime dependency.

**Deviation.** None.

**Verification.** `npm run verify` at `fab3262`: **392 checks, 0 failures** (182 + 42 + 168).

### W15 — "Draft a fix prompt" on findings

**Shipped.** A button on every actionable finding — an unused AI endpoint, an
orphaned `window` name, a file over the threshold, a known gap, a tripped
tripwire — turns it into a bounded instruction for a Claude Code session on
HaTi, carrying the real file paths and identifiers from the scan and the
owner's standing boundaries verbatim, including "Do not build or modify the
mobile/WhatsApp counterparty portal", running the project's verification before
finishing, and producing `BUGLOG.md` and `SUMMARY.md` updates. It renders in
the assistant panel with a copy button. The facts come from the scan on the
server; the model writes the wording, not the research, and a finding that no
longer exists is refused rather than drafted around. Same key, same daily
budget, same rate limit — there is no second path to Anthropic.

**Deviation.** None.

**Verification.** `npm run verify` at `2ed15db`: **416 checks, 0 failures** (187 + 61 + 168).

### W16 — Knock on the doors for real

**Shipped.** A "Check the live site" button on the open-doors panel asks the
running HaTi whether the doors the code calls open really are, and reports one
of five plain answers per door: as written, wants login, gave data, not there,
no answer. Every limit is fixed in `lib/doors.mjs` and cannot be changed at
runtime — GET only, so nothing that would write data is ever called; owner
triggered only, so nothing knocks on its own; one request at a time, half a
second apart, eight seconds each, thirty at most; and the whole check limited
to twice a quarter hour. Only the status code and a size band are kept; the
response body is discarded unread, so there is nothing for it to leak. Unset
`HATI_URL` disables the button and says why.

**Deviation.** One addition, and it is the important one: the brief lists four
verdicts and the code has five. "Not there" (a 404 — the code describes a door
the live site does not have) was split out from the generic surprise, because
it means something different and the fix is different.

**Verification.** `npm run verify` at `f8a8dee`: **455 checks, 0 failures** (200 + 61 + 194).

### W17 — CI: verify on every push

**Shipped.** `.github/workflows/verify.yml` runs the same `npm run verify` a
person runs locally, on every push and every pull request: Node 22, `npm
install`, the Playwright Chromium the suite drives, then the suite. Read-only
permissions. Nothing live is needed — the suite starts its own server and the
panels that need a running HaTi assert the "cannot reach it" wording instead.
The run's own token cannot read HaTi's repository, so CI falls back to the
stand-in and says so at the top of the run; a repository secret
`HATI_SCAN_TOKEN` takes over when set, which is also the answer if the default
token's rate limit ever proves too tight.

**Deviation.** The workflow's YAML is checked by a small structural reader
written into `test/auth.mjs` rather than by a YAML library, because rule 2 says
no new dependencies and that rule is worth more than a tidier test. It asserts
the triggers, the read-only permission, the Node version, the commands, and
that the command it runs is the one `package.json` defines. It does not claim
to validate YAML in general. The browser-install step was not executed on this
machine — Chromium is pre-installed here and the environment blocks the
download — so the suite was run locally under `npm install` then `npm run
verify`, which is the rest of what the workflow does.

**Verification.** `npm run verify` at `7b07f62`: **470 checks, 0 failures** (200 + 61 + 209).

### Where the run finished

**`npm run verify` on the completed codebase: 470 checks, 0 failures** — 200 in
the browser run, 61 in the assistant's tool loop, 209 in the login, limits and
library checks. The run started at 215 and added 255 checks across seventeen
items, which is roughly what rule 5 asks for: every feature carrying at least
one new check, and most of them carrying several.

Read that number with W0 in mind. It is proof that the Mapper behaves as
described, measured against a stand-in shaped like HaTi. It is not a statement
about HaTi's current source, because nothing in this sandbox could reach it.

Nothing was abandoned, nothing was left unattempted, and no item was left
half-finished at a boundary.

---

## After the run — four fixes from reading the real screen

The owner looked at the running dashboard and raised three things; a fourth
came out of the same screenshots. Each was pitched as a before-and-after
proposal first and built only once approved, one commit each.

### 1. The night's changes are numbered

The commit list ran together in small grey type, in the order git hands them
over — newest first, which is the wrong way round for a report about a night's
work. They are now turned into the order the work happened and numbered from
one, under the date they happened, with each reference code moved into a chip
out of the way of the sentence. The numbering is worked out on the server, so
the card and the morning email tell the same story with the same numbers.

**Verification.** `npm run verify`: **515 checks, 0 failures** (228 + 61 + 226).

### 2. "Getting bulky" says what each file is

A row reading `server/server.js` is an address, not an answer. Every row now
leads with what the file **is** and one sentence on what it does, with the path
demoted to a chip.

Almost none of those sentences is hand-written, which is the part worth
noticing: a file that renders a screen borrows that screen's own words, a file
named in the dependency map is the parts it holds, and the file every route is
answered in counts its own routes. All three sources are already validated on
every scan, so none of it can quietly become wrong. Exactly two files fall
through to a new `FILE_COPY` block, and a file nothing can explain says "no
plain-English note yet" rather than being guessed at. The panel also explains
what a KB is and what the 60 KB line means.

### 3. Bigger type, pinned tabs, and your place kept

The page was mostly 11.5px. Everything went up about a quarter, with padding
and row spacing raised alongside so the result is more room rather than more
crowding. The tab row is pinned to the top of the window, each tab remembers
where you left it, and a tab opened for the first time starts at its own
beginning instead of at the top of the document.

**This took two attempts, and the second correction came from the owner.** The
first version kept a remembered position per tab and opened an unvisited tab at
its start. The owner used it and reported the original complaint unchanged —
both of those are movements. The mechanism was deleted: switching tabs now
holds the scroll position exactly, full stop. Every panel reserves a screenful
so a short one cannot collapse the document and drag the reader up with it, and
Chrome's scroll anchoring is switched off for the page. The check now clicks
all nine tabs in a circuit and requires each to hold the position to within two
pixels; the one case that cannot be honoured — scrolling deeper than a short
panel reaches — is asserted to land at that panel's end rather than at the top.

A third round came from being asked to test it by hand rather than assert it:
driving the page in a real browser and looking at the screenshots showed the
tab row itself had begun scrolling sideways, because raising the type had
pushed the nine tabs past the width of the column. Clicking a tab near the end
slid the whole row, moving every other tab out from under the cursor — the same
complaint on the axis nobody was checking. The tabs wrap onto two rows now, and
a check holds them there.

Re-driven afterwards: **zero pixels of movement across all nine tabs at
1500x900, 1280x720 and 1440x1100**, with the panel heading landing on the same
line every time.

All three rounds are in `BUGLOG.md`. Each was found a different way — one by
making a test discriminate, one by the owner using the page, one by looking at
a screenshot — and the suite was green through all three.

### 4. "0 scans" no longer printed bare

The footer said *"put together from 0 scans"* directly under sixteen commits.
Both halves were true — the commits are GitHub's record, the scans are the
Mapper's own observations — but together they read as a fault. The wording now
carries that difference.

### One addition to the stand-in

A fixture commit may now date itself `midnight+90m`. Without it no stand-in
could ever produce a "last night" to report on, so the morning card would have
gone unexercised in the browser. Only the fixture reader understands the form;
nothing arriving from GitHub can produce one.

---

## Before this run — what the platform already was

Everything from here down describes the rounds that came before the July 2026
build run: the dashboard itself, the login, the assistant and the change log.
It is kept because it is still an accurate description of the platform those
rounds produced, and the seventeen items above were built on top of it.

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

**An assistant and a change log were added in a later round**, both
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
crossed 60 KB. Seventy-two hours is the default view; everything is also
archived, so the panel can be asked about the last 7, 30 or 90 days. A scan
that finds nothing changed adds nothing, so the log is a list of events rather
than a list of look-ups.

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
against a real server, and runs three suites in one command:

| Suite | What it covers | Checks |
|---|---|---|
| `test/verify.mjs` | The eight points below, through the real browser | 200 |
| `test/chat-loop.mjs` | The assistant's tool loop, its budget and its key precedence | 61 |
| `test/auth.mjs` | The login, the limits, the history, and the libraries directly | 209 |
| **Total** | | **470 checks, 0 failures** |

The eight points the browser run exists for:

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

Three notes on how those were run:

- **Which copy of HaTi's source was read.** Every suite asks GitHub once
  whether HaTi's repository is readable and prints the answer before its first
  check. In the July 2026 build sandbox it was not, so all three ran against
  the stand-in in `test/fixture/` — see W0 below. The counts above are
  therefore proof of the Mapper's own behaviour, not of any statement about
  HaTi's current source. On a machine with a token that can read
  `mkataba-clm`, the same command reads the real thing with nothing to change.
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

**Severity on the "Not finished" panel.** Severity is used where a source
states it, and none of HaTi's sources did at the last live reading — not the
README, not `SECURITY.md`, not the code. So the dots are neutral and the panel
says the ordering is source order, not a ranking. This is the most visible
difference from the mockup, which had confident red/amber/grey dots. W13 built
the other half: a bullet in HaTi's README or `SECURITY.md` beginning `[high]`,
`[medium]` or `[low]` is ranked and coloured from the next scan onwards, and
one that says nothing still gets nothing. The convention has to be adopted in
HaTi's own documents first — it is in the owner list at the top of this file.

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

**Read the date on these.** They come from the last scan of the *live* HaTi,
before the July 2026 build run. That run could not reach HaTi's repository at
all (W0), so none of them was re-confirmed by it — the numbers below describe
HaTi as it was, and the next scan from a machine that can read the repository
will say whether they still hold. Nothing here was carried forward on faith;
it is simply not fresh.

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
