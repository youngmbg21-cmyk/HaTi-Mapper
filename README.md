# HaTi-Mapper

An internal diagnostic dashboard for [HaTi](https://github.com/youngmbg21-cmyk/mkataba-clm),
the contract lifecycle platform. Eight panels answering eight questions about
the product, written for someone who does not read code:

| Panel | Answers |
|---|---|
| **Screens** | Every screen in the product, what a person does there, and the file it lives in |
| **Where the money goes** | Every feature that calls Anthropic, which model, which cap, which screens use it — and roughly what it costs |
| **Where things are kept** | Every database table and what is inside it |
| **What breaks what** | Pick a piece of data, see everything that depends on it — and what changing it can break that is already signed |
| **Not finished** | Known gaps, gathered from the code and the written documents |
| **Open to the public** | Everything that works without logging in |
| **What changed** | What the Mapper itself has watched move over the last 72 hours, plus recent commits |
| **Getting bulky** | File sizes, and the names published on `window` that nothing references |

There is also an **assistant** — a chat panel that can explain any of it in plain
English. It reads the same data the tabs show and nothing else.

**"Is this what's live?"** A badge under the title answers the one question
that could make everything else on the page misleading: whether the code being
described is the code your customers are actually using. The scan knows which
version it read; HaTi's pulse reports which version is deployed. Green means
they match. Amber means the live site is running something else, with the
number of commits behind when that can be worked out and no number when it
cannot. Grey means HaTi is not answering, so the honest reply is "can't tell" —
never "probably fine".

Seven of the eight panels are read from HaTi's **source code**. Only "Where the
money goes" needs anything from a running HaTi, and all it asks for is caps and
a count.

**"The scanner could read 96% of what it looks for."** One line under the
headline numbers. Every panel is built by matching patterns against source that
someone else is free to change, and when it changes shape nothing breaks
loudly — the panels quietly fill up with "not detected" and still look fine.
This counts the facts the scan set out to establish against the ones it
actually got, so that decay is visible as a falling number. A warning counts
against the score as well as the fact it is about, which makes the number
deliberately pessimistic: this is an alarm, and an alarm that flatters is worse
than none. The score goes into every snapshot, so a drop shows up in the change
log and can be watched.

---

## Security

The Mapper is a new door into information about HaTi, so three rules shape it:

**1. Numbers only, never content.** Two things here touch a running HaTi, and
neither can carry its data. HaTi's `/api/pulse` returns caps, a request count,
a boolean, a mode and a commit hash — no contract text, counterparty, party
email, monetary value, file name, user name, session token, share token or API
key can cross it, and where the dashboard shows that a key is configured, HaTi
returns a boolean rather than the key. The door check ([Knocking on the
doors](#knocking-on-the-doors)) sends plain `GET` requests to routes the code
already describes as public, and keeps only the status code and a size band;
the response body is discarded unread, so there is nothing for it to leak.

**2. HaTi's endpoint is off by default, one direction, read-only.** It exists
only when `MAPPER_TOKEN` is set in HaTi's environment; unset, the route returns
404 as though it were never built. It requires that token as a bearer
credential, is `GET` only, is rate limited, and sends no CORS headers — the
Mapper calls it server-to-server, and their absence stops any browser reaching
it directly. The Mapper never writes to HaTi.

**3. The Mapper is behind your own login.** It displays HaTi's file paths, its
unauthenticated routes and its known weaknesses, so it asks for an email and
password. Passwords are hashed with scrypt and a per-account salt; sessions are
server-side behind an httpOnly, SameSite=Lax cookie, Secure whenever the
connection is https. Every route that returns or changes anything requires a
session — `/api/auth/status` and `/api/health` are the only ones that answer
without one, and neither returns any data.

**Rate limits know who you are.** Every limit — sign-in, reset, scan, chat —
is counted against the address Express derives from the connection and the one
proxy hop in front of it (`trust proxy 1`), not against the `x-forwarded-for`
header a caller can write for themselves. Render's edge appends the real caller
to that header, so its last entry is the truthful one and anything a caller
puts in front of it is ignored. Sign-in is capped at 12 attempts per 15 minutes
from one address.

**Ten wrong passwords close the account.** A per-address limit cannot see a
guess spread across many addresses, so the account keeps its own count as well:
after ten wrong passwords in a row, from anywhere at all, sign-in stops
answering for 15 minutes and says so — *"Too many wrong passwords. Try again in
N minutes."* Signing in correctly clears the count, and so does completing a
password reset, since that already proves you can read the owner's email. The
count is written to `account.json`, so restarting the service is not a way to
wipe it.

**Forgotten password** sends a single-use link that expires in 30 minutes. Only
a hash of the token is stored, so a copy of the account file cannot be used to
reset. Completing a reset signs every device out. The route answers identically
whether or not the address is the owner's, so it cannot be used to discover
which email the Mapper belongs to.

**The page may only load what it actually needs.** A Content-Security-Policy
refuses everything by default and then names the exceptions: one script, from
this service; styles from this service, including the inline `style=""`
attributes the markup uses; the two Google Fonts hosts; the icon, which is a
`data:` URL; and requests to this service's own `/api/*`. No outside script can
run, inline or otherwise, and the page cannot send anything anywhere else. The
headless run asserts the policy is sent and that the browser reported no
violation of it.

Secrets live in environment variables or in the server's own state directory.
**No token, key or credential appears in `index.html`, in `app.js`, or in any
other file served to the browser** — the server serves exactly two files and
refuses everything else, and `npm run verify` asserts it.

---

## Environment variables

Set these in the Render dashboard. None belongs in git.

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | A **fine-grained** personal access token with **read-only Contents** permission on `youngmbg21-cmyk/mkataba-clm` **and nothing else**. Without it GitHub allows 60 requests an hour, which a handful of scans exhausts; with it, 5,000. |
| `HATI_URL` | Base URL of the running HaTi, e.g. `https://hati-clm.onrender.com`. Unset → the spend panel shows code defaults and says so, and "Check the live site" on the open-doors panel is switched off with that reason on screen; the other seven panels are unaffected. |
| `MAPPER_TOKEN` | Must match the `MAPPER_TOKEN` set on **HaTi**. This is the bearer credential the Mapper presents to HaTi's `/api/pulse`. |
| `MAPPER_OWNER_EMAIL` | **Recommended.** The only email allowed to claim the account. Without it, whoever reaches the URL first can claim it — so set this before the first visit, or set up your account immediately. |
| `RESEND_API_KEY` | **Needed for password resets by email**, and for the optional morning summary. Without it the reset link is written to the service log instead, which still works but means anyone with dashboard access could read it while it is valid; the morning summary simply is not sent, and the Settings tab says so. |
| `MAPPER_URL` | Optional. This dashboard's own address, used only to put a link at the bottom of emails you asked for. |
| `EMAIL_FROM` | Optional. From-address on the reset email. Defaults to Resend's shared sender. |
| `ANTHROPIC_API_KEY` | **Optional and not the normal route** — the assistant's key is set inside the platform, on the Settings tab. This exists only as a fallback; a key set in the page takes precedence. |

Optional: `HATI_REPO` (default `youngmbg21-cmyk/mkataba-clm`), `HATI_REF`
(default `main`), `COMMIT_COUNT` (default `20`), `PORT` (default `3000`),
`ANTHROPIC_MODEL` (default `claude-sonnet-5`), `CHAT_DAILY_LIMIT`
(default `200`), `MAPPER_DATA` (default `./.mapper-state`),
`LOGIN_LOCK_MINUTES` (default `15` — how long sign-in stops answering after ten
wrong passwords; there is no reason to change it outside a test).

---

## The assistant

A chat panel that answers questions about the platform — "what should I be
worried about", "what changed yesterday", "what is this costing me" — in plain
English rather than developer language. It is built the same way as HaTi's own
Copilot: the model is given tools, fetches real data before answering, and
finishes by delivering a grounded answer with links to the tab that shows it.

**What it can and cannot see.** It reads the scan payload, the 72-hour change
log and the live caps — exactly what the dashboard already displays. It has no
tool that can reach HaTi's database, so no contract, counterparty, name, email
or monetary value can reach it even if asked directly.

**Giving it a brain.** Sign in, open the **Settings** tab, and paste an
Anthropic key from
[console.anthropic.com](https://console.anthropic.com/settings/keys). That is
the normal route — the key lives in the platform, not in your hosting
dashboard. It is stored on the server, never sent back to the browser, and only
the last four characters are ever shown. Behind the login, only you can read or
change it.

`ANTHROPIC_API_KEY` still works as an environment fallback if you prefer it,
but a key set in the page takes precedence, the same way HaTi treats its own.

**Cost control.** The assistant is rate limited (40 questions per 15 minutes)
and has a daily ceiling (`CHAT_DAILY_LIMIT`, default 200 questions, resetting
at midnight UTC), so a runaway loop cannot run up a bill. Answering a question
never triggers a repository download.

Two details make that ceiling real rather than nominal. The day's count is kept
on disk in `MAPPER_DATA`, so restarting the service — which on Render's free
tier happens after every idle period — does not hand back a fresh allowance.
And a question is only counted once Anthropic has actually answered it: a
rejected key, a rate limit or an outage costs nothing against the day. Without
a writable state directory the count falls back to memory and the service log
says so.

---

## "Draft a fix prompt"

The dashboard was good at showing what is wrong and no help at all with doing
something about it. The next step is always the same — describe the finding
accurately to an overnight Claude Code session — and describing it accurately
means naming files and identifiers nobody should have to remember.

So findings carry a **Draft a fix prompt** button: a paid AI endpoint nothing
calls, a name published on `window` and never used, a file over the line, a gap
the documents admit to, and any tripwire that has gone off. Pressing it writes
a prompt for a session on **HaTi's** repository that states the finding with
the real paths and identifiers, scopes the change narrowly, and ends with your
standing rules reproduced word for word — no mobile/WhatsApp portal, no new
dependencies, nothing outside the scope, run the verification before finishing,
update `BUGLOG.md`, `SUMMARY.md` and the README. Copy it out of the chat panel
and paste it.

The facts come from the scan, on the server; the model writes the wording, not
the research, and is told to add nothing. A finding that no longer exists is
refused rather than drafted around. It goes through the same key, the same
daily budget and the same rate limit — there is no second way to reach
Anthropic.

## Knocking on the doors

Everything else in the Mapper answers *what does HaTi's code say*. The "Open to
the public" list is a claim of that kind: a route with no login check in its
middleware chain. Reality can differ — a proxy rule in front of it, a deploy
that never landed, a guard added inside the handler where the scan cannot see
it. **Check the live site** on that panel asks the running HaTi and reports
what actually came back.

Each door gets one of five answers, in plain words: *as written*, *wants login*
(the code says no login is needed; the live site disagrees), *gave data* (the
code says it checks its own secret; it handed something over anyway), *not
there*, or *no answer*. The two in the middle are the ones worth acting on, and
they are coloured as surprises rather than listed alongside the rest.

It is the only thing in the Mapper that deliberately touches the live site, so
every limit is fixed in the code and none of them can be changed at runtime:

- **GET only.** A route declared `POST`, `PUT`, `PATCH` or `DELETE` is never
  called, because calling it would write data. It is listed as left alone, with
  that reason on screen. So is anything needing an unguessable code in its URL.
- **Never automatic.** Nothing knocks unless you press the button. No scan, no
  schedule and no tripwire can start a check.
- **One at a time, half a second apart, eight seconds each, thirty at most.**
  That is a person knocking, not a scanner sweeping. The panel states those
  limits before you press, and repeats what it actually did afterwards.
- **Status codes and a size band only.** No response body is read, stored or
  shown. This must not become a way of pulling HaTi's data through the Mapper,
  and the surest guarantee of that is never to look.

The button needs `HATI_URL` set. Without it the panel says so plainly instead
of offering a control that cannot work. The check itself is rate limited to two
presses per quarter hour, and the last result is kept so the page can show it
again without knocking a second time.

## Which way things are moving

A strip of six small charts on the overview, drawn from the archive's
measurements: everything all together, the biggest single file, doors that need
no login, things not finished, how much the scanner can read, and a day at the
caps in money.

Each is a sparkline with the value it stands at now and one sentence saying
which way it has gone — *"33% bigger than 90 days ago"*. The shape is the
point; there are no axes, because "growing every week for a month" is the
insight and the numbers on the side are not. Movement in the unwelcome
direction is coloured as such rather than merely shown.

Below three readings the strip says **"not enough history yet"** and draws
nothing, because a line through one point is a lie. The charts are plain SVG
built in `app.js` — no chart library, because Express is the only runtime
dependency and it is going to stay that way.

## Severity on "Not finished"

The panel gathers known gaps from HaTi's README, its `SECURITY.md` and the
notes left in the code. None of those sources states how serious anything is,
so nothing is ranked and the panel says so — the order is source order, not a
judgement.

**If you want them ranked, the documents can say so.** Start a bullet in HaTi's
README or `SECURITY.md` with `[high]`, `[medium]` or `[low]` (case doesn't
matter) and that bullet gets a severity and moves up the list; the tag itself
never appears in the text. Untagged bullets keep their source order underneath
the ranked ones. Nothing is ever inferred: a bullet with no tag has no
severity, and the Mapper will not guess one from its wording.

The panel also shows how the list has moved — *"3 closed, 1 opened in the last
30 days"* — counted from the change log, so it covers only the time the Mapper
has been watching.

## Roughly what it costs

"Where the money goes" used to show models and request counts and never money,
which left the obvious question unanswered.

The honest difficulty is that HaTi's pulse reports numbers only — no token
counts — so there is nothing real to multiply. What the source *does* state is
the ceiling each handler puts on one answer, its `max_tokens`. Every estimate
is built from that, with the assumption printed on the panel rather than
hidden: **each request is priced as if it used its whole answer allowance twice
over, once going in and once coming out.**

So the figures are a roof, not a bill — a real request is almost always
smaller, and the panel says so in those words. You get a per-use estimate for
every feature, what one person hitting the rate limit could spend, and a
whole-day ceiling at the limits the code sets. Prices come from
`data/pricing.js` and are hand-maintained; a model with no entry shows "price
not on file" rather than borrowing a similar model's price, and a price list
older than 90 days says so on the panel. The daily estimate goes into every
snapshot, so it can be charted and watched.

## Tripwires

The dashboard shows everything, all the time, which is exactly the problem: you
have to remember to look, and to know what to look for. Settings → *Being told
about things* holds five rules you set once and then stop thinking about. Each
is written as an instruction rather than as a setting name:

| Rule | Default |
|---|---|
| Tell me the moment a door opens that needs no login | **On** |
| Tell me if a new kind of link starts opening without a login | **On** |
| Tell me when any file gets bigger than *N* KB | Off, 100 KB |
| Tell me if the live site makes more AI requests in a day than *N* | Off, 150 — only checkable when the Mapper can reach the running HaTi |
| Tell me if the Mapper can read less of what it looks for than *N*% | Off, 90% |

The two armed by default are the two about somebody else being able to reach
HaTi's data. The rest are about cost and tidiness, and being nagged about those
unasked would only teach you to ignore the banner.

They are checked on every scan, against the same snapshots the change log is
built from. When one goes off: a red banner is pinned to the top of the
dashboard until you dismiss it, and a high-priority entry goes into the change
log — which means it also appears in the next morning's summary. The first rule
does not wait for morning: if the email path is switched on it sends
immediately, because a door that needs no login is not a thing to read about
over breakfast.

A rule that has already raised a banner does not raise it again on the next
scan; dismissing it lets it fire afresh.

## When the Mapper itself stops working

A monitoring tool that quietly stops monitoring is worse than none: the scan
fails, the page keeps serving the last good one, and everything looks correct
while describing older code.

So consecutive scan failures are counted. Three in a row and a banner is pinned
to the top of the page — how long it has been failing, the plain reason, and
that what you are looking at is stale. If `RESEND_API_KEY` is set you also get
one email, once, and not another until a scan succeeds. Without a provider the
banner says the same thing. A successful scan wipes the count, so the next
outage alerts again.

## "What did last night's session do?"

The question the owner asks every morning, answered as one card at the top of
the **What changed** tab. The same events the log below holds, but grouped —
doors that need no login first, then cost, storage, screens, gaps, file sizes —
with the git commits from the same window, how far the scanner's grip slipped,
and how much the whole thing grew. A quiet night says so plainly, because "no
session ran last night" is worth knowing too.

`GET /api/digest` serves it, `?period=midnight` (the default), `24h` or `72h`.

**By email, if you want it.** Settings → *Email me each morning*. With
`RESEND_API_KEY` set, the same report goes to the owner's address once a day,
on the first scan after 6am local time. It is plain text, and it carries
nothing beyond what the change log already holds — names, paths, counts and
byte sizes. Without a provider the switch still works and the Settings tab says
plainly that nothing will be sent; the card on the dashboard is unaffected
either way. Set `MAPPER_URL` if you want the email to link back to the
dashboard.

## The change log

Every scan is compared with the one before it. Anything that moved becomes a
plain-English entry — a new screen, an AI feature that changed model, an
address that started working without a login, a file that crossed 60 KB, a gap
that was closed.

A scan that finds nothing changed adds nothing, so the log stays a list of real
events rather than a list of look-ups. It holds names, paths, counts and byte
sizes only — the same class of information the dashboard already shows.

**72 hours is the default view; nothing is thrown away.** The "What changed"
tab has a range control — 72 hours, 7 days, 30 days, 90 days. The first is the
working set the next scan is compared against; the rest come from an archive
file that every round is written to as it happens. Alongside each round the
archive keeps a handful of measurements — total bytes, largest file, how many
open addresses, how many gaps — which are numbers only, with no names or paths
in them, and which is what makes the trend lines on the overview possible.

The archive is capped at 10,000 events and 5,000 measurements, oldest dropped
first, so it cannot grow without bound. Ten thousand events is years of
ordinary use.

It is written to `MAPPER_DATA` (default `./.mapper-state`), alongside your
account, the AI key and the day's question count, so all of them survive
restarts.

**They do not survive a redeploy unless a persistent disk is attached** — and a
redeploy happens every time this repository changes. Without a disk you would
have to set your password again after each one. The Settings tab says so on
screen when that is the case. To fix it permanently: in Render open the service
→ **Settings → Disks → Add Disk**, mount it at `/var/data`, then add
`MAPPER_DATA=/var/data` to the environment.

---

## Deploying

`render.yaml` at the repository root defines one Node web service — no build
command, `npm start`, health check on `/api/health`, mirroring HaTi's own
blueprint. On render.com choose **New + → Blueprint**, connect this repo, then
set the variables above in the dashboard.

Then, on **HaTi's** service, set `MAPPER_TOKEN` to the same value and redeploy.
Until you do, the spend panel degrades gracefully and everything else works.

**On first visit** the Mapper asks you to set up your account. Do this straight
away — until you do, the account is unclaimed. Setting `MAPPER_OWNER_EMAIL`
beforehand means only your address can claim it.

**One Render caveat.** On the free tier a service spins down after inactivity
and takes the better part of a minute to wake. The ten-minute scan cache lives
in memory and dies with it, so the first load after an idle period is slow. The
front end says what it is doing and roughly how long it will take rather than
appearing to hang.

## Running locally

```
npm install
GITHUB_TOKEN=ghp_... npm start
```

Then open http://localhost:3000. `npm run verify` drives the whole thing
headlessly and asserts the checks in `test/verify.mjs`.

**Running the checks without access to HaTi.** Every check needs a scan to
succeed first, which normally means downloading HaTi's repository. Where that
is not possible — no network, no token yet, or a machine allowed to see only
this repository — the suite asks GitHub once, then falls back to the stand-in
in `test/fixture/`: a small tree shaped like HaTi, with no real content in it.
The fallback is printed at the top of the run and never chosen silently, and a
scan that read it marks itself `fixture: true` and carries a warning saying so,
so a stand-in can never be mistaken for the live product. Set `HATI_FIXTURE` to
a directory to force it by hand. Leave it unset in production, which is the
default — then the tarball download is the only way source reaches the scanner.

## Checks on every push

`.github/workflows/verify.yml` runs the same `npm run verify` on every push and
every pull request: Node 22, `npm install`, the Playwright Chromium the suite
drives, then the suite itself. No live HaTi and no deployed Mapper is involved —
the suite starts its own server on a spare port, and the panels that need a
running HaTi assert the "cannot reach it" wording instead.

The token it hands the scan is the one GitHub issues for the run, read-only. It
can read this repository but not HaTi's, so CI falls back to the stand-in in
`test/fixture/` and says so at the top of the run. **To have CI scan the real
HaTi, add a repository secret named `HATI_SCAN_TOKEN`** — a fine-grained token
with read-only Contents permission on `youngmbg21-cmyk/mkataba-clm` and nothing
else. It is also the answer if the default token's rate limit ever proves too
tight. With no such secret the workflow uses the run's own token, so it works
unchanged either way.

---

## Turning HaTi's endpoint off

Clear `MAPPER_TOKEN` in **HaTi's** environment and restart it. The route stops
existing and `/api/pulse` returns 404. The Mapper notices, says so on the spend
panel, and carries on serving the other seven panels from source. There is
nothing to un-deploy and no code to remove.

---

## How the scan works

One request downloads the entire HaTi repository as a gzipped tarball, which is
unpacked in memory (`lib/tar.mjs`, ~90 lines, no dependency) and parsed
locally. Walking GitHub's contents API file by file would be hundreds of
requests. Commit history is a separate call, plus one per commit for its file
list — about 22 requests for a cold scan, against an authenticated ceiling of
5,000 an hour.

Results are cached in memory for ten minutes. The **Rescan** button sends
`?refresh=1`, which bypasses the cache. If a rescan fails, the last good scan
is served with a warning rather than an error page.

Dependencies: Express, and nothing else.

---

## What is derived, and what is written by hand

Almost everything on the page is read out of HaTi's source on every scan. Two
files are hand-maintained, and both are **validated against the source on every
scan** — anything stale comes back as a warning that the page displays, so the
map degrades visibly instead of quietly lying.

### `data/dependencies.js` — the "what breaks what" map

Hand-written by design. Which subsystems read the contract body, and where
changing it can break something already signed, are judgements about meaning; a
parser guessing at them would produce a confident, wrong diagram.

Validated per scan: every subsystem's `file` must still exist, every `proof`
identifier must still appear in the source, every `field` an item names must
still appear, and every subsystem id an item points at must be defined.

### `data/pricing.js` — what Anthropic charges

There is no way to read a price out of HaTi's source and no endpoint that
reports one, so the numbers are written down: dollars per million tokens, per
model, with the date they were checked.

Validated per scan, exactly like the other two: a model HaTi is actually using
with no entry renders **"price not on file"** rather than borrowing the price
of a similar-looking name, and if the `asOf` date is more than 90 days old the
panel says the prices may have moved. Update it by checking Anthropic's pricing
page, changing the numbers, and changing `asOf`.

### `data/copy.js` — the plain-English phrasebook

The sentence explaining what a person *does* on a screen, and what an AI
feature is *for*, cannot be read out of code either. A screen's label, module
path, size, render function and nav position are all derived; only the sentence
is written.

Validated per scan: an entry for a screen or feature that no longer exists is
reported as stale, and a screen or feature with no entry renders as "not
detected" rather than silently blank.

### Where the scan says "not detected"

Deliberately. A visible gap is more useful than a confident wrong answer, so
the scan marks rather than guesses:

- **Custom value streams.** Users create them at runtime and they are saved to
  their own browser's `localStorage`, never to the server, so no amount of
  source reading can enumerate them. The panel shows the six built-in streams
  and says why that is the whole list.
- **Severity on the "Not finished" panel.** None of the sources — README,
  `SECURITY.md`, the code — states one, so none is shown.
- **A commit's areas**, when its file list could not be fetched.
- **A screen's module**, if `setView()` dispatches to a function that is not
  declared in any scanned file.
- **A feature's tier or model**, if the handler's `anthropicMessages()` call
  cannot be resolved.
