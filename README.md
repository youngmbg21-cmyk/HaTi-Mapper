# HaTi-Mapper

An internal diagnostic dashboard for [HaTi](https://github.com/youngmbg21-cmyk/mkataba-clm),
the contract lifecycle platform. A control tower and seven panels answering the
questions worth asking about the product, written for someone who does not read
code:

| Screen | Answers |
|---|---|
| **Control tower** | The morning question — is anything wrong? Spend, the scan calendar, open doors, what needs attention, how much of HaTi the scanner could read, and where the weight sits |
| **Screens** | Every screen in the product, what a person does there, and the file it lives in |
| **Money** | Every feature that calls Anthropic, which model, which cap, which screens use it — and roughly what it costs |
| **Doors** | Everything that works without logging in — the code's promise about each one beside what the live site actually did |
| **Changes** | Last night's report with the code updates folded in, what is still not finished, and what the Mapper has watched move over 72 hours or up to 90 days |
| **What breaks what** | Pick a piece of data, see everything that depends on it — and what changing it can break that is already signed |
| **Where things are kept** | Every database table and what is inside it |
| **Getting bulky** | File sizes, and the names published on `window` that nothing references |
| **Settings** | The assistant's key, what is worth interrupting you for, and your account. Reached from the gear in the top right, not the tab row |

There is also an **assistant** — a chat panel that can explain any of it in plain
English. It reads the same data the tabs show and nothing else.

**Every tab but the control tower opens with its answer.** A row of counters
across the top — the number, a traffic light saying whether that number is
fine, and where the Mapper has a reading from a week ago, which way it has
moved — then the detail under it. The counters are drawn by one shared piece of
code, so a colour means the same thing on every screen, and the week-on-week
arrow is left off entirely rather than drawn as a zero when there is nothing to
compare against.

**The control tower is a summary, never a second source.** Every figure on it
is read from the same scan the panels below are drawn from, so the two can
never disagree; the verification suite asserts exactly that. Where a card needs
history the Mapper has not gathered yet — the spend line, the "was 96% a week
ago" comparison — it says so rather than drawing a shape that means nothing.

**Dark by default, light on request.** The switch is the sun in the top right.
The choice is remembered in this browser only: it is a preference about a
screen, not a fact about HaTi, so it never reaches the server.

**"Is this what's live?"** A badge in the footer answers the one question
that could make everything else on the page misleading: whether the code being
described is the code your customers are actually using. The scan knows which
version it read; HaTi's pulse reports which version is deployed. Green means
they match. Amber means the live site is running something else, with the
number of commits behind when that can be worked out and no number when it
cannot. Grey means HaTi is not answering, so the honest reply is "can't tell" —
never "probably fine".

The scan learns which version it read from the tarball itself: GitHub names a
tarball's root directory `owner-repo-<sha>`, so the very first request of a
scan carries the answer. It used to come from the commit-history fetch instead
— a separate, best-effort call twenty requests deeper, and the first place a
rate limit lands — so whenever that fetch failed, the badge went grey saying
*"could not read which version"* about a fact already sitting in memory. Now
the history fetch failing costs the "Code updates" list and nothing else, and
when even that has to be said, the badge says *why* (hover it for the raw
error) instead of leaving a mystery.

**Every colour on the page is measured, not judged by eye.** The two greys the
page uses for anything secondary were chosen by eye once and both were under
the readable line — the lighter one reached 2.56:1 on white, not far off half
the minimum for body text. Both are now measured against every surface they
land on, in both themes, and the suite fails if either drops under 4.5:1 or if
the muted grey ever becomes louder than the weight above it.

Everything the scan looked for and could not read is listed in full in two
places: a card of its own under the gear, and a popup that the "Scanner grip"
warnings circle opens on click. Both group the list by what would be done about
it — a note here describing a part of HaTi that has gone, a part of HaTi with no
note written yet, something the scanner could not read — because thirty-four
warnings in one column is a wall rather than an answer. Both carry a **Copy
all** button, and every single warning has one of its own, because the list is
what you hand to whoever is going to fix it. What lands on the clipboard is
plain text with the repository, the version and the scan time at the top, so it
is worth pasting into a session or an email without editing.

An alarm you cannot get the detail of is an alarm with the label torn off,
which is why the detail is one click from the number rather than three. The
circle breathes between its resting grey and
a clear alert red — slowly, so it reads as "alive and asking" rather than as an
emergency strobe — because these warnings mean "some of what you are reading
may be wrong", which is the one thing on the page that should not sit still and
quiet. With reduced motion requested it holds the red instead of pulsing. The
circle counts the whole warning list, the same list the popup and the Settings
card show, so the number you click is the number you get.

Everything but one panel is read from HaTi's **source code**. Only "Money"
needs anything from a running HaTi, and all it asks for is caps and a count.

**"The scanner could read 96% of what it looks for."** The "Scanner grip"
card on the control tower. Every panel is built by matching patterns against source that
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
other file served to the browser** — the server serves exactly three files
(`index.html`, `app.js` and `charts.js`) and refuses everything else, and
`npm run verify` asserts it. `charts.js` is not in the page head: it is fetched
the first time an answer actually asks for a chart, which most sessions never
do. It is served from here rather than from a CDN because this page's
Content-Security-Policy allows scripts from this origin and nowhere else.

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

**It does not look like the page under it.** The panel floats over the
dashboard and is built from the same card and tile tokens as everything
beneath it, which left it reading as one more card rather than as something
that had opened on top. Its two ends — the title bar and the strip holding the
question box — are banded green so the edges are obvious at a glance. The
middle is deliberately left plain: the conversation is what should be read,
not the frame around it. The field you type into keeps its own background for
the same reason, and the Ask button swaps its two colours over, since green on
green is no button at all.

### Plain or Technical

Above the question box are two buttons: **Answers · Plain · Technical**. Plain
is the default and the one most people should stay on.

This is **not a tone or a personality setting**. It changes what an answer is
allowed to leave out.

- **Plain** — everyday language, two or three sentences unless more is genuinely
  needed. The answer first, then the reason. What it means for the business
  rather than what the machine did. Any technical term is explained in the same
  breath.
- **Technical** — full engineering depth. Exact route addresses, file paths,
  identifiers, model ids, timestamps and figures as they appear in the data,
  with assumptions stated and no distinction simplified away.

**Plain is a shorter answer, never a less accurate one.** A caveat, a warning,
a risk or a "someone needs to look at this" is carried in both registers; the
plain version says it in plainer words and never drops it to be brief. If
something is genuinely uncertain, both versions say so.

Four things about how it behaves, each of which is a real bug in products built
this way and is therefore pinned by `test/copilot.mjs`:

1. **The choice sticks.** It is remembered in the browser and saved on the
   server, so it follows you onto a new device. Whoever needs plain needs it
   every time.
2. **Flipping it re-says the answer already on screen**, in place, in the
   register just chosen — it is not only a preference for the next question.
   The existing message is *replaced*; a second bubble would read as a second
   opinion, and it is one explanation wearing two registers. Once both versions
   exist they are both kept, so flipping back and forth is instant and never
   asks the model again. With nothing on screen, flipping only remembers.
3. **The style rules are built when the question is asked**, never assembled
   when the server starts. A frozen copy means flipping the toggle moves the
   button and changes nothing else for the rest of the session.
4. **Every path that asks the model anything carries it.** That is a shape
   rather than a checklist: the server reaches Anthropic from exactly one place
   and the browser posts to it from exactly one place, and both are asserted.
   It includes the tool description sitting next to the question and the fixed
   list of instructions the "Draft a fix prompt" path sends — a specific
   instruction close to the question silently beats a general style rule in the
   background briefing, so those enumerations respond to the register too.

Alongside the register, every call in both registers carries the rules that
make an answer trustworthy rather than merely fluent: use the figures and
timestamps you were given and never invent or recompute one; say "I can't see
that from here" rather than guess; distinguish "this is broken" from "this
looks unusual"; and never call something fixed unless the data shows it
recovered.

### Charts inside an answer

An answer can carry **one** chart. The model never supplies its numbers.

It names a *kind* — nothing else, no numbers, no labels, no dates — and before
the answer is drawn the page pulls that request out and fills it from the same
live records the dashboard beside it is drawn from. So a chart in an answer is
built by the same code, from the same readings, as the tab it came from: it
cannot drift, it cannot go stale and it cannot be hallucinated. A model that
invents a number gets to invent a *sentence*, which you can weigh. It never
gets to invent a *chart*, which reads as a measurement.

The kinds are drawn from what this dashboard actually measures — the cost of a
day at the caps, cost and usage cap per AI feature, addresses open without a
login, scanner grip, total size, known gaps, observed changes by day and by
area, and the largest files. There are deliberately no charts for deploys,
tests or response times: the Mapper does not measure those, and a chart kind
for something unmeasured is an empty box waiting to happen.

The one exception is a `quoted` chart, which draws two to twelve figures the
model has already stated in the same reply, in one unit — and it is labelled on
screen as **the assistant's own figures**, not as measured data.

If a chart has no readings behind it yet, if the model names a kind that does
not exist, if its request cannot be read, or if the drawing code cannot be
fetched, you get a card saying which — never a blank box and never a broken
panel. The drawing code (`charts.js`) is fetched the first time an answer
actually asks for a chart; most sessions never do, so it is not in the page
head. Every live chart is held in one registry and destroyed when the
conversation is cleared or its card scrolls well out of view, because a chart
holds a canvas, its listeners and its animation frame, and dropping the markup
without destroying it leaks all three.

### How an answer is rendered

Answers render as markdown — headings, bold, lists, tables, quotes, code
blocks — and **the model's output is treated as untrusted input.** Log lines and
error messages from the monitored system flow through this renderer, so the
escaping is the security boundary rather than a nicety. Every chunk that is not
markdown is escaped, quotes and apostrophes included, because chunks end up
inside attribute values. Link schemes are checked against an allow-list —
`https://`, `http://`, `mailto:`, `#`, and a path on this origin — rather than a
block-list: `javascript:` and `data:` are the two everybody remembers and the
next one has not been invented yet. An address that fails the check still
renders as the text it is; it simply stops being clickable.

The model can also colour short spans — a status, a deadline, a figure, a risk
statement, never ordinary prose: `{+good news}`, `{-bad news}`,
`{!needs attention}`, `{~context}`. These are applied after the markdown has
run, on text that is already escaped, and cannot match across a tag.

The band has its own colour token rather than borrowing the accent green,
because it carries body text and the accent does not have to. In the light
theme near-white on the accent reaches only 3.6:1, under the line for text
that size; the band is two steps darker and clears it at 5.3:1. Both themes
are asserted in `test/verify.mjs` as measured contrast ratios — the styling
here has been lost once already, and "it looked fine" is what let that
through.

**Two different things are called "changes", and it may not mix them up.** The
change log is what the Mapper *observed* by comparing one of its own scans with
the next — a door opened, a file grew. Commits are the git log: the messages
someone typed when saving work. They are different numbers counting different
things, and twelve commits say nothing about whether anything was observed to
move. The assistant once answered a question about the calendar's figure by
reaching for the commit count and telling the owner the dashboard was wrong,
when both numbers were right and only one of them was the answer. So the system
prompt separates them explicitly, the change tool is named as the only source
of a change count, and an empty log is stated to be a real answer rather than a
gap to fill from somewhere else. It is told never to call a figure on the
dashboard wrong on the strength of a different measurement. All of that is
asserted in `test/chat-loop.mjs`, against what is actually sent to the model.

**It says so while it works.** Fetching real data before answering means a
question can sit for the better part of a minute, and the answer arrives in one
piece — there is no progress to stream. So the panel shows a marker with words
on it: *"Reading your question"*, then *"Looking things up on this page"*, and
past ten and thirty seconds two more that say it is still going. The wording
moves on with the wait rather than describing steps, because the page cannot
see which lookup is running and will not pretend otherwise. It is announced to
a screen reader as well as drawn, since an animation on its own tells nobody
anything.

**What it can and cannot see.** It reads the scan payload, the 72-hour change
log and the live caps — exactly what the dashboard already displays. It has no
tool that can reach HaTi's database, so no contract, counterparty, name, email
or monetary value can reach it even if asked directly.

**It can explain every number the dashboard shows — the money ones included.**
That has to be said because it briefly could not: the tool serving the AI panel
left out the cost block, so the assistant, asked about the $106 on "Today's
burn", truthfully found no dollar figure in its data — and then guessed,
wrongly, that the number must be live billing data from inside HaTi that it was
blocked from seeing. The opposite is true. Those figures are the Mapper's own
estimates — the caps in HaTi's code times the prices in `data/pricing.js`,
priced pessimistically, a roof and never a bill — and no dollar figure ever
crosses from the running site. The tool now carries the same estimates the tile
shows, labelled as estimates in the result itself; the headline figure sits in
the system prompt before any tool is called; and the instructions forbid it
disowning a number the dashboard is displaying. A dashboard's assistant
speculating that the dashboard's own headline is someone else's secret data is
the exact kind of confident wrongness it exists to prevent.

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

It also carries the Plain/Technical toggle, and this is the one place where
what the register changes is narrow on purpose. The drafted prompt is read by a
coding session, so its file paths and identifiers stay exact either way — plain
English never means a vaguer path. What moves is whether the prompt opens with
a sentence in ordinary English explaining what is wrong, for you reading it
before you paste it.

## Reading it, and keeping your place

Two things about using the dashboard rather than about what it says.

**It is not set in fine print.** The whole page went up about a quarter — body
text to 15px, the notes under each panel to 13.5px, headings and row spacing to
match — with the card padding and table rows raised alongside it, so the effect
is more room rather than more crowding. Nothing moved and nothing changed
meaning.

**Switching tabs does not move the page.** On any screen at least 900px wide
and 620px tall the app is a **fixed frame**: the tab row is a fixed part of the
top of the window, the scan stamp a fixed part of the bottom, and whichever
panel is open scrolls in the gap between them. The document itself never
scrolls at all.

That is a stronger guarantee than the one it replaces, and a simpler one.
Earlier versions let the whole page scroll and put the position back after a
tab switch, which works but is a correction — it can only ever be as good as
its arithmetic. With the row and the stamp outside the box that moves, there is
nothing to correct. Each panel is its own scrolling box, so it also keeps its
own place: leave a long table half-read, come back, and it is where you left
it, without any code remembering a number.

Below that size the frame would squeeze the tiles past reading, so the page
goes back to scrolling the ordinary way, with the tab row pinned as before.

**The control tower does not scroll at all.** The other panels are lists and
tables that can honestly run past a screen; the tower is the morning glance,
and a glance that needs scrolling is not one. So inside the frame it divides
the gap into seven tiles across two rows — the top row taller, because it
carries the two charts, the month and the door history — and each tile is a
fixed box that fits its contents. Where a tile holds a list of unknown length,
the list scrolls inside the tile rather than pushing the page taller, which
keeps its neighbours where they are. The suite measures this at 1920×1080,
1440×900 and 1280×720: nothing may scroll, no tile may be cut off, and all
seven must still be drawn — fitting by rendering less is not fitting.

Two things still shape the row itself:

- **The tabs stay on one line.** They sit above a screen measured to the pixel,
  so a second row of tabs is a row taken off every tile beneath it. As the
  window narrows they give up their padding, then their size, and below 1340px
  the signed-in email gives way before they do — the account is one click away
  under the gear. They never scroll sideways: a sliding strip moves a tab out
  from under the cursor as you click it.
- **Settings is not in the row.** It is the gear in the top right, beside the
  theme switch and Rescan, because it is a place you go rather than a panel you
  read.

An alarm is the one thing allowed above the tabs. A tripwire that has gone off
puts its banner at the very top of the frame and pushes the row down, which is
where an alarm belongs. What may not happen is the row sliding away as you
read, and that is what the suite asserts — not a CSS keyword, but the row's
position before and after reading to the end of the longest panel.

## "Getting bulky" says what each file is

A line reading `server/server.js` is a file path — the address of one file
inside HaTi, the way "kitchen, top drawer" is an address inside a house. It
tells a developer where to look and tells the owner nothing, which made the
panel unreadable for the person it is written for.

Every row now leads with what the file **is**, and one sentence on what it does.
The path is still there, demoted to a small chip for whoever wants it.

Almost none of those sentences is written by hand, because the answer was
already in the payload:

- **A file that renders a screen** borrows that screen's own words from
  `data/copy.js` — *"The Workspace screen. Read, edit, review, comment, share
  and sign a single contract."*
- **A file named in `data/dependencies.js`** is the parts it holds — *"Signature
  seal · Audit trail."* Both the file and its proof identifier are already
  checked to still exist on every scan, so this cannot drift into a lie.
- **The file every route is answered in** counts its own routes — *"The engine
  room. Every request HaTi answers arrives here, all 41 of them."*
- **Anything nothing else explains** falls through to `FILE_COPY` in
  `data/copy.js`, which is two entries long, and a file even that cannot
  explain says **"no plain-English note yet"** rather than being guessed at.

The panel also explains its own units, because "195 KB" means nothing on its
own: a kilobyte is how much text a file holds, 60 KB is roughly fifteen to
twenty printed pages of code, and past that a file gets hard for a person — or
an AI session — to hold in mind at once. That is all the gold colouring says.

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

The archive's measurements have no card of their own. There used to be a strip
of six sparklines under the control tower, and it was the reason the tower
needed scrolling — six charts of the second-most-interesting version of numbers
the tiles above already showed, sitting below the fold where the morning glance
never reached them.

So the series now feeds the tower's tiles instead, each one putting the history
into the tile the number belongs to:

- **Today's burn** draws the spend line across every reading, with what it
  stands at now on the chip.
- **Open doors** draws the last seven readings as bars, so a door that appeared
  is a step rather than a sentence.
- **Scanner grip** says what it was at the start of the log — *"Was 96% at the
  start of the log — HaTi moved under the patterns."*
- **The total size** says whether it grew or shrank over the log.
- **The month** marks which days were scanned and which of those found
  something, and counts this month's changes underneath it.

The calendar reads the change log over the archive's whole 90 days rather than
the Changes panel's chosen range. Fed by that range it drew a month from three
days of log while shading "scanned" days from ninety days of readings — one
picture built from two windows, with the shorter one winning silently.

Below three readings the spend line is not drawn at all and the tile says so,
because a line through one point is a lie. Everything is plain SVG built in
`app.js` — no chart library, because Express is the only runtime dependency and
it is going to stay that way. `/api/trends` is unchanged; only what reads it is.

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

**The night's code updates are numbered.** Git hands its commits over newest-first,
which is the wrong way round for a report about a night's work. They are turned
into the order the work actually happened and numbered from one, so number 1 is
where the session started and the last number is where it left off. The date
sits above the list — "since midnight" is relative, a date is not — and each
line keeps its short reference code in a chip on the right, out of the way of
the sentence. The numbering is worked out once, on the server, so the card and
the email tell the same story with the same numbers.

**A count of nothing is explained, not printed bare.** The footer used to say
*"put together from 0 scans"* directly beneath a list of commits, which reads
as a fault. Both halves were true and the wording now carries the difference:
the commits come from GitHub's record, and the Mapper's own observations only
exist once it has looked. Before its first scan of the day it says so.

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

**The Mapper looks when you open the page, and at no other time.** There is no
schedule and no background job; the only thing on a timer in the whole service
is rate-limit cleanup. A scan runs when the dashboard is loaded, reusing the
previous result for ten minutes, or immediately when you press Rescan. So a
change is only ever found between two visits — open it, let HaTi change, open
it again — and an empty log can mean HaTi has been still or that nobody has
been to look.

The card said the flattering one of those. Faced with an empty list it answered
*"the Mapper has looked N times and found HaTi unchanged each time — that is a
good sign, not a broken page"*, and it was wrong twice over. The count was the
number of **snapshots**, and a snapshot only exists when something did change,
so it could not see the looks that found nothing — the exact ones that sentence
is about. And "a good sign" needs a sample: two looks finding nothing and two
hundred looks finding nothing are opposite facts.

So looks are now counted for real, including the quiet ones, and the card says
how many there have been, when the last one was, that opening the page is what
makes it watch, and — below three looks — that this is too thin to call quiet.
If the last look was over a day ago it says that too, and points at Rescan.

**"Watching since" is gone**, for the same reason. It implied continuous
watching, and its date was not when watching began — it was the oldest snapshot
still retained, which creeps forward as old ones are pruned past 72 hours. When
it last looked is a fact the service actually holds.

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

**A redeploy replaces the service's own directory, so without a persistent disk
none of it survives one** — and a redeploy happens every time this repository
changes. `render.yaml` therefore declares a 1 GB disk mounted at `/var/data`
and sets `MAPPER_DATA` to match, so the blueprint creates a Mapper that keeps
what it learns.

This is not only about having to set your password again. The change log is
built by comparing each scan with the one before it, so a wiped directory
returns the Mapper to a first-ever scan: one reading, nothing to compare
against, and an empty log. The dashboard then correctly reports zero changes,
having genuinely observed none — and it would do that again after every deploy,
which makes a 90-day archive that can never hold more than the time since the
last one. The failure is quiet, because every number involved is true.

If your service was created before the disk was added to the blueprint, add it
by hand: in Render open the service → **Settings → Disks → Add Disk**, mount it
at `/var/data`, then add `MAPPER_DATA=/var/data` to the environment.

**The Settings tab tells you which of the three states you are in**, and this
is worth knowing because it used to tell you the wrong one. It reported the
state as safe whenever a write succeeded — which it does, on a directory the
host is about to replace, right up until it does. So the page said the account,
the key and the change log were permanent while every one of them was being
wiped on each deploy: true sentence, wrong question, and the one place the
owner would go to check. It now separates them:

| What it says | What it means |
|---|---|
| Nothing is being saved | The directory cannot be written to at all |
| This is not a permanent disk | Writes work, and the host replaces the directory on every deploy |
| Written to `<path>`, outside this service's own directory | A mounted volume — a deploy does not touch it |

The third is inferred from the state directory sitting outside the service's
own, which is what a mounted volume looks like from inside the container. That
is a strong signal and not a proof, so the wording on screen says exactly that
rather than promising more than it established.

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

A commit in the stand-in's `_commits.json` may write its date as
`midnight+90m`, meaning ninety minutes after today's midnight. Some of what the
dashboard shows is about *last night* — the morning summary above all — and a
stand-in with only fixed dates in it could never reach that state. Only the
fixture reader understands the form; nothing coming from GitHub can produce one.

## Checks on every push

`.github/workflows/verify.yml` runs the same `npm run verify` on every push and
every pull request: Node 22, `npm install`, the Playwright Chromium the suite
drives, then the suite itself. No live HaTi and no deployed Mapper is involved —
the suite starts its own server on a spare port, and the panels that need a
running HaTi assert the "cannot reach it" wording instead.

`npm run verify` is four files. `test/verify.mjs` drives the dashboard,
`test/chat-loop.mjs` drives the assistant's tool loop against a stand-in model,
`test/auth.mjs` drives the login, and `test/copilot.mjs` drives the Copilot
panel — the register read at call time rather than frozen, flipping restating
the answer on screen in place, both versions cached, every prompt path carrying
the register, the model unable to inject markup through a reply, and an unknown
chart kind showing a card rather than breaking the panel.

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
still appear, every subsystem id an item points at must be defined, and every
subsystem must sit in one of the three groups the panel draws — a subsystem
with no group would silently vanish off the board, so it says so instead.

### `data/pricing.js` — what Anthropic charges

There is no way to read a price out of HaTi's source and no endpoint that
reports one, so the numbers are written down: dollars per million tokens, per
model, with the date they were checked.

Validated per scan, exactly like the other two: a model HaTi is actually using
with no entry renders **"price not on file"** rather than borrowing the price
of a similar-looking name, and if the `asOf` date is more than 90 days old the
panel says the prices may have moved. Update it by checking Anthropic's pricing
page, changing the numbers, and changing `asOf`.

**How the Mapper knows an endpoint costs money.** HaTi tags every paid route
with `aiFeature('name')` in its middleware chain — that tag is what its own
spend ledger and budget guard key on — so a route carrying it is a paid route
by the product's own definition, wherever in the API it lives. The Mapper used
to look for routes under `/api/ai/` whose handler contained an Anthropic call
instead, and got three answers wrong against the real HaTi: it missed a paid
endpoint outside that prefix entirely, reported a paid one as free because its
Anthropic call sits in a helper, and reported a free admin route as paid. All
three understated or muddled what the product costs. See `BUGLOG.md`.

### `data/copy.js` — the plain-English phrasebook

The sentence explaining what a person *does* on a screen, and what an AI
feature is *for*, cannot be read out of code either. A screen's label, module
path, size, render function and nav position are all derived; only the sentence
is written.

The same file also holds `FILE_COPY`, but it is deliberately tiny — see
[Getting bulky](#getting-bulky-says-what-each-file-is) for why almost nothing
needs writing there.

It also holds two additions the redesigned tabs needed, both the same shape:
derived structure, written names.

- **`GROUP_COPY`** — HaTi's menu wraps its buttons in sections, so *which*
  section a screen sits in is read off the markup. What the markup does not
  carry is what to call each one: it says `work`, not "Working on one
  contract". The ids are derived, the names are written here.
- **`TABLE_COPY`** — a table's name, its columns and the line it is declared on
  are all read out of the `CREATE TABLE` statements. What a person cannot get
  from that is what the table is *for*. "contracts, twelve columns" is a
  schema, not an answer.

Validated per scan: an entry for a screen, feature, file, menu section or table
that no longer exists is reported as stale, and anything with no entry renders
as "not detected" rather than silently blank.

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
