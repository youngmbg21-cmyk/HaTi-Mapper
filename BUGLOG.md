# BUGLOG

Every problem hit during the July 2026 build run: what broke, what was tried,
and how it ended. Written as it happened, in order.

---

## W0 — The verification suite could not run at all

**What broke.** Before any work item could start, `npm run verify` failed on
its first real assertion. All three test files start a server and need a scan
to succeed before they can check anything, and a scan means downloading
`youngmbg21-cmyk/mkataba-clm` from GitHub. In the build sandbox that download
returns `GitHub 401 Bad credentials`, and a direct request returns `403`: the
session's network policy allows this repository and no other, and the token in
the environment is the sandbox's own injected credential, not a GitHub PAT.

    [scan] failed: GitHub 401 for /repos/youngmbg21-cmyk/mkataba-clm/tarball/main

So rule 4 — "`npm run verify` must pass at the end of every work item" — was
unsatisfiable on the first line of the run, for a reason that has nothing to do
with the Mapper's code.

**What was tried.**

1. An unauthenticated request, in case the repository is public: `403` from the
   network gateway, not GitHub.
2. The injected token against the Mapper's own repository: `200`. Against HaTi:
   `403`. Confirmed the block is per-repository policy, not a bad token.
3. Adding `mkataba-clm` to the session. **Rejected, not attempted** — hard rule
   3 of the brief says scope is this repository only and forbids cloning HaTi.

**How it ended.** Fixed, by making the suite able to run without reaching HaTi.

- `lib/fixture.mjs` reads HaTi's source from a directory when `HATI_FIXTURE`
  names one, returning the same `Map` shape the tarball reader returns. Unset —
  which is what production is — nothing in it is ever called and the tarball
  path in `lib/github.mjs` is untouched.
- `test/fixture/` is the stand-in: 33 files shaped like HaTi (a nav, view
  modules, an Express server with routes, tables and nine AI features, a README
  and a `SECURITY.md`). It contains no real content of any kind. It is built to
  satisfy `data/dependencies.js` and `data/copy.js` exactly, so a fixture scan
  produces zero stale-map warnings and the panels are populated the way a real
  scan populates them.
- `test/source.mjs` asks GitHub once per run whether the repository is
  readable and falls back to the fixture only if it is not. The choice is
  printed at the top of every run and never made silently.
- A fixture scan sets `fixture: true` on the payload and pushes a warning
  saying so, so a dashboard reading a stand-in can never be mistaken for one
  reading HaTi.
- `test/verify.mjs` check 8 (scan cost) measures GitHub requests when the real
  repository was read, and asserts the stand-in was declared when it was not.

**Deviation, stated plainly.** The brief did not ask for this. It is a
test-only capability with no new dependency, and it is the reason every work
item below could be verified at all. The cost is real and worth naming: in this
sandbox, no work item was verified against the *live* HaTi. The checks prove
the Mapper's own behaviour — its parsers, routes, login, limits, panels and
degradation paths — against a repository shaped like HaTi. Anything that
depends on HaTi's *current* source (exact screen count, exact file sizes,
whether a particular gap is still open) has not been re-confirmed by this run.
Running `npm run verify` anywhere with a GitHub token that can read
`mkataba-clm` restores the live path automatically, with no flag to set.

**Evidence.** `npm run verify` after this change: 131 + 34 + 50 = 215 checks,
0 failures.

---

## W0b — Building the stand-in broke twice on its own quoting

**What broke.** `test/fixture/server/server.js` has to be parseable by the
Mapper's own route scanner, and that scanner only recognises single-quoted
route paths — `app.get('/api/thing', …)`. The generator that wrote the fixture
emitted double quotes, so a scan of it found zero routes and the "open to the
public" panel came out empty.

**What was tried.** A regex pass over the generated file turning double-quoted
route paths into single-quoted ones. That fixed the routes and broke the file:
some of those lines contain JavaScript string literals of their own, which were
now single quotes inside a single-quoted string.

    SyntaxError: Unexpected string

**How it ended.** Fixed, by switching the affected generator lines to
double-quoted outer strings so the emitted code carries single quotes without
escaping. The lesson is recorded rather than the workaround: the fixture must
be shaped like HaTi *as the scanner reads it*, not merely as a human reads it,
so anything the scanner is fussy about has to be reproduced exactly.

---

## W1 — A new sentence in the README tripped the check it shipped with

**What broke.** W1 added a sweep asserting that no document still claims things
the code has since contradicted, one of which is any mention of
`MAPPER_ACCESS_TOKEN` — the shared token that was removed when the login went
in. The sweep immediately failed on the README sentence W1 itself had just
written, which explained that `MAPPER_ACCESS_TOKEN` no longer exists.

    FAIL  Nothing still mentions MAPPER_ACCESS_TOKEN as if it existed

**What was tried.** The obvious fix — narrowing the pattern so a sentence that
says the variable is gone does not count — was rejected. A check that can be
talked around by wording is not a check.

**How it ended.** Fixed by rewriting the sentence so it names what replaced the
token instead of naming the token. The check stayed exactly as strict as it was
written to be.

---

## W6 — Two variables named `stranger` in one test file

**What broke.** W6 added drift assertions to `test/auth.mjs`, which already had
a `stranger` further up (an address that is not the owner's, used in the
password-reset checks).

    SyntaxError: Identifier 'stranger' has already been declared

**How it ended.** Fixed in seconds by renaming the new one to `unknownCommit`,
which is also what it actually is. Recorded because it is the kind of thing a
single long test file invites, and the file is now long.

---

## W7 — Four scans do not make four archived rounds

**What broke.** The archive test scanned four times and asserted four rounds
came back over a 30-day window. Three did, and the assertion that read the
fourth then threw.

    FAIL  Asking for 30 days finds the older ones too
          3 rounds
    FAIL  The login test itself completed
          TypeError: Cannot read properties of undefined (reading 'at')

**What was tried.** Nothing in the archive: the code was right and the
expectation was wrong. The first scan of a fresh Mapper is a baseline — there
is no previous snapshot to compare it against, so it produces a measurement
point and no events, and a round is a set of events. Four scans therefore give
four points and three rounds.

**How it ended.** Fixed by correcting the expectation to 3 rounds and 4 points,
with a comment in the test saying why, so the next person to read it does not
"fix" the archive.

---

## W9 — The morning summary wrote "1 one worth looking at first"

**What broke.** Two failures in the digest checks. The headline assertion
expected a sentence about commits that the headline was not building, and a
pluralising helper called as `plural(serious, 'one', 'of them')` produced the
sentence above when exactly one thing was serious.

    FAIL  The headline says how much moved, in words

**How it ended.** Both fixed. The headline now includes the commits clause it
was always supposed to, and the sentence is constructed rather than assembled
from a plural helper that was never meant to carry a noun phrase. Worth
recording because the output was grammatical nonsense on the one path nobody
looks at — a single serious finding — and only a test caught it.

---

## W11 — A commit that changed behaviour without changing the README

**What broke.** Not code: process. Rule 6 of the brief says every change that
alters behaviour must be reflected in `README.md` **in the same commit**. W11's
commit went in with the scan-failure alerting built and tested and no README
section describing it.

**How it ended.** Fixed by writing the section and amending the commit, so the
history satisfies the rule rather than merely ending up satisfying it. No other
commit in the run needed the same correction.

---

## W13 — A fifteen-day window that contained everything

**What broke.** The gap-movement check seeded two change rounds and asserted
that a fifteen-day window saw fewer of them than a thirty-day one. It saw both,
because both seeded rounds fell inside fifteen days.

    FAIL  A shorter window sees less
          {"days":15,"opened":2,"closed":2}

**How it ended.** Fixed by asserting against a five-day window instead, which
genuinely excludes the older round. The counting code was never wrong; the test
was asserting something the fixture did not set up.

---

## W14 — Two wrong assumptions about the trend strip

**What broke.** The seeded-archive checks expected six points per sparkline and
expected six of the six series to be drawn as unwelcome growth. Both were
wrong.

    FAIL  Each is drawn from every reading in the archive
          7,7,7,7,7,7
    FAIL  Growth in the wrong direction is not drawn as good news

The first: the server takes its own scan on start-up, so a six-reading archive
becomes seven points by the time the page draws it. The second: three of the
six series are byte counts, and the stand-in's real byte totals are far below
the seeded values, so those three are drawn as *shrinking* — correctly.

**How it ended.** Both fixed by asserting what is actually true and stable:
that every line is drawn from the same number of readings and that there are at
least six of them, and that the three series which genuinely rise across the
window — open doors, gaps, money — are the ones coloured as unwelcome. Neither
change weakens the check; the original expectations were simply describing a
run that never happens.

---

## W16 — Waiting for a button that was never going to appear

**What broke.** The new browser check for the door panel waited for the
navigation button before clicking it, and timed out after three minutes.

    waiting for locator('.nav button[data-p="public"]') to be visible
    360 × locator resolved to hidden <button role="tab" data-p="public">

**What was tried.** Nothing else — the log said exactly what was wrong. The
button exists from the first byte of HTML but lives inside `#app`, which stays
hidden until the server confirms a session, so it is *attached* and never
*visible* until then.

**How it ended.** Fixed by waiting for `#app:not([hidden])` — the state that
actually means "signed in and rendering" — and clicking the tab after that. The
same page had been driven this way elsewhere in the file; this check simply
waited on the wrong thing.

---

---

## Final outputs — the W1 sweep caught me a second time

**What broke.** Writing up W1 in `SUMMARY.md` at the end of the run meant
describing the stale comment that W1 deleted, and the tidiest way to describe a
sentence is to quote it. Quoting it put the sentence back into a document the
W1 sweep reads, so the last verification run of the whole build failed on it.

    FAIL  Nothing claims the Mapper has no login

**How it ended.** Fixed the same way it was fixed in W1: the write-up now says
what the comment denied rather than repeating its words, and the check was left
exactly as strict as it is. Recorded because it is the second time in one run
that this check caught its own author, which is the strongest argument for
keeping it that could be made.

---

## After the run — a browser check that asserted nothing

**What broke.** The four fixes the owner asked for after seeing the real screen
were built and the suite went green, including the check meant to prove that
switching tabs no longer throws you to the top of the page. Reading its output
rather than its verdict showed the problem:

    PASS  There is enough page to scroll for this to mean anything
          parked at 900
    PASS  A tab opened for the first time starts at its own beginning
          900 against a nav line of 900
    PASS  And coming back puts you where you left it
          left at 900, returned to 900

Every number was 900. The parked position, the panel's start and the restored
position had all landed on the same value, because the scroll had been clamped
to the bottom of a short page. Two of those three checks could not have failed
whatever the code did.

**What was tried.** Making the test discriminating: park a distance below the
tab row and clear of the bottom, then assert the three positions are different
numbers as well as the right ones. That turned one of them red immediately —
which is the point.

The bug it exposed was real and in the shipped code. To send someone to "the
top of this panel" you have to know where the tab row rests, and the row is
`position: sticky`. While it is pinned, `getBoundingClientRect().top` is zero,
so `rect.top + scrollY` gives back the scroll position you already had —
`Math.min(scrollY, thatValue)` is then just `scrollY`, and the page never
moves. Switching to `offsetTop` on the theory that sticky positioning is a
paint-time effect and leaves layout alone did not help: Chrome reports the
pinned offset there too. The trace was unambiguous once the call was recorded
rather than reasoned about — `scrollTo({top: 1000})` when 418 was wanted.

**How it ended.** Fixed by measuring the panel instead of the tab row. A panel
is an ordinary element, so its rect is honest at any scroll position, and
"where this panel begins, less the height of the row pinned above it" is a more
direct statement of the intent than "where the row rests" ever was.

**Worth keeping.** The failure here was not the sticky-positioning trap — that
is just a browser detail. It was a green check that could not go red. A test
whose inputs coincide reports success for a codebase that does nothing at all,
and the only way to notice is to read the numbers it prints rather than the
word in front of them.

---

## The tab fix was still wrong, and the owner said so

**What broke.** Nothing, by the suite's account: the checks above were green
and the code did what they described. The owner then used the page and reported
the original complaint unchanged — *"when I click on the different tabs the
page jumps to a different location so I am never on the same eye view level."*

They were right, and the checks had been written to the wrong requirement. The
design sent you to the top of a panel you had not opened before and to a
remembered position on one you had. Both of those are movements. Asked for
stillness, I had built cleverness, then written checks that faithfully asserted
the cleverness.

**How it ended.** The whole mechanism was deleted — the per-tab memory, the
first-visit rule and the measurement it needed. Switching tabs now holds the
scroll position exactly where it is, and that is all it does. Every panel
begins on the same line beneath the pinned tab row, so the new heading lands
where the old one was.

Two supports were needed to make holding possible rather than merely intended.
A panel too short to fill the window shrank the document when it opened, and
the browser dragged the scroll up with it, so every panel now reserves a
screenful. And Chrome's scroll anchoring moves the position on its own when
content above the viewport changes height, which is exactly what swapping
panels does, so it is switched off for this page.

The replacement check clicks all nine tabs in a circuit from one parked
position and requires every one of them to hold it to within two pixels. The
first attempt at that failed on seven tabs, which is what surfaced the
document-height problem underneath.

**Worth keeping.** Twice on the same feature the tests agreed with the code and
the code was wrong. A check can only ever hold the implementation to the
requirement it was written from, so a requirement misread at the start stays
misread all the way through a green suite. The user saying "it still jumps" was
worth more than any of it.

---

## Driving the page by hand found what the suite could not

**What broke.** Asked to test the tab fix rather than assert it, I drove the
real dashboard in a real browser — park at a reading position, click all nine
tabs, screenshot each, and record where the window and the panel heading
actually ended up. The numbers were clean at two window sizes and 4px out at a
third. The screenshots were not:

    Screens | Where the money goes | ... | What changed
    ^ the row had scrolled sideways; "Screens" was half off the left edge

Raising the type in the previous change had pushed the nine tabs past the width
of the column — they need 1306px and have 1096. The row had been
`overflow-x: auto` since long before, so it silently became a scrolling strip.
Clicking a tab near its end slid the whole row to bring it into view, which
moves every other tab out from under the cursor. That is the owner's complaint
exactly, on the axis nobody was checking.

**How it ended.** Both fixed. The tabs wrap onto two rows instead of scrolling,
so every one of them is always visible and always in the same place; below
700px the row gives up its pin rather than eat a phone screen. The 4px was the
panel reserve being three pixels short of what a tall window needs — the
document could not quite reach the parked position — so the reserve went from
`100vh - 130px` to `100vh - 100px`. Re-driven afterwards: zero pixels of
movement across all nine tabs at 1500x900, 1280x720 and 1440x1100, with the
panel heading landing on the same line every time.

A check now asserts the row never scrolls sideways and that all nine tabs are
within it, so this cannot come back the next time the type changes.

**Worth keeping.** Three rounds on this one feature, and each was found a
different way: the first by making a test discriminate, the second by the owner
using the page, the third by looking at a screenshot. The suite was green for
all three. Automated checks are good at holding a thing still once you know
what to hold; they are no good at all at noticing what you never thought to
measure.

## The Copilot round — four things that went wrong

**A sentinel that turned the front end into a binary file.** The markdown
renderer lifts fenced blocks out before anything is escaped and leaves a marker
in their place. The first version used a literal NUL character as that marker,
written straight into `app.js`. It worked, and `grep` immediately started
reporting `app.js: binary file matches` — every search of the front end became
useless. Replaced with a printable record-separator character, written as a
named constant, and any copy of it arriving from the model is stripped before
parsing so a reply cannot forge one. The lesson is small and worth keeping: a
control character in a source file costs you every tool that reads it as text.

**An escaping check that could not have failed.** The first test for "quotes
and apostrophes are escaped" read the rendered bubble's `innerHTML` back out of
the DOM and looked for `&quot;`. It will never be there: serializing a text
node escapes `&`, `<` and `>` and leaves quotes alone, so the assertion was
testing the browser's serializer rather than the renderer. Worse, the
replacement regex for "no handler attribute survived" matched the *escaped
text* ` onerror=` and failed on output that was completely safe. Both were
rewritten to inspect real attributes on real elements, plus a separate check
that drives the real "Draft a fix prompt" button with a reply engineered to
break out of the copy button's `data-copy` attribute — which is the place a
model chunk genuinely lands inside an attribute value. A test that cannot fail
is worse than no test, because it reports as a pass.

**A chart that kept the dark palette on a light card.** Everything on this page
follows the theme because everything is styled by CSS. A canvas is not: it
holds pixels, and the colours it drew with were read off the page at the moment
it drew. Switching the theme left the chart's axis labels in the dark theme's
near-white on a white card — visible in a screenshot, invisible to every
assertion in the suite. The theme handler now repaints every live chart, and a
check compares the canvas before and after the switch. Found by looking at the
picture, not by running the tests.

**A phone check that was never signed in.** The narrow-screen assertions opened
a fresh browser context to get a phone viewport, which meant a fresh cookie
jar, which meant the sign-in card rather than the dashboard, which meant a
three-minute timeout on a selector that was never going to appear. The fix was
also the more honest test: resize a page in the *same* signed-in context,
because the property being checked is that this app has one layout and one
panel rather than a separate mobile screen.

## The tab redesign — four things that went wrong

**Three collisions with class names the page already used.** The redesign added
a set of shared pieces — a counter row, a group board, a measured bar — and
three of their class names were already taken. `.bcol` and `.bar` belong to the
control tower's own bar chart, and `.who` is the signed-in-user chip in the top
bar. The symptom in each case was a layout that looked deliberate and was not:
the group columns bottom-aligned themselves because `.bcol` carries
`justify-content:flex-end` for the tower's bars, and the feature rows laid
themselves out horizontally because `.who` is a flex row. I spent a while
reading my own grid rules for a bug that was in someone else's. The fix was to
rename mine — `.gcol`, `.mbar`, `.rwho` — and the lesson is that in a
single-stylesheet app a new class name needs a grep before it needs a rule.

**Renaming one occurrence too many.** The `.bcol` rename was done with a
string replace across `app.js`, which caught both the new group columns and the
tower's own bar columns. The tower kept rendering — it just lost its bar
layout — so nothing failed, and the only reason it was caught was a screenshot
of a tab that was not being worked on. A blind replace across a file is not a
rename.

**A catch that reported every fault as a network failure.** After the Changes
tab lost its fourth card, `setLoading()` still tried to write into the element
that had gone, threw, and the page reported *"The server did not answer"* — so
the first place I looked was the server, which was fine. That handler wrapped
the whole of boot, including the page's own drawing code, and flattened both
into one message. It now distinguishes the two: a genuine failure to reach the
server still says so, and a fault in the page is re-thrown so it reaches the
console as itself. This is the second time in this project a catch-all message
has cost more time than the bug behind it.

**A test that was asserting the old layout, and one that was right to.** Most
of the suite's failures after the redesign were simply pinned markup — `tbody
tr` where there are now ranked rows, `#publicBody` where there is now one
merged list — and updating them to the new shapes is what a redesign means. One
was not: the suite asserted a fix-prompt button for every unused published
name, and the design replaced those with plain chips and a single bulk button.
That would have quietly removed the ability to ask about one name. The chips
became the buttons, so the design's shape and the capability both survive.

## Reading the real HaTi — three ways the money panel was wrong

The Mapper had been reading the stand-in. Pointed at the live HaTi it produced
34 warnings, which is the mechanism working: the hand-written phrasebook
described a product that had moved on. Most were straightforward — HaTi's menu
now has two sections rather than four, three screens are gone, and the database
has 26 tables where it had 10. Those were rewritten from HaTi's own source.

Four were not that, and all four made the "Where the money goes" panel
under-report what the product costs.

**A paid endpoint the scanner could not see at all.** HaTi tags every route
that spends money with `aiFeature('name')`. The Mapper instead looked for
routes whose path starts `/api/ai/` and whose handler contains a literal
`anthropicMessages(` call. `/api/templates/upload` is tagged
`aiFeature('template_convert')` and lives outside that prefix, so it appeared
on no panel at all — and it turns out to be the single most expensive feature
HaTi has. The day's ceiling was short by its share. The test is now the tag,
wherever the route lives, because where a route costs money is HaTi's to
declare and it declares it there.

**A paid endpoint reported as free.** `/api/ai/playbook` reaches Anthropic
through a helper rather than calling it in the handler, so the literal-call
test found nothing and filed it under "costs nothing".

**A free endpoint reported as paid.** `/api/ai/log` is an admin read of the
Copilot history and calls nothing, but a route's body is taken as everything
up to the next route, and it had swallowed a neighbour that does call
Anthropic. It appeared as a feature with no description and no cost ceiling —
two more warnings, both about a thing that should not have been there.

**And underneath one of them, a real parser bug.** Following the helper still
did not work, and the reason was `functionBody()`: it took the first `{` after
the function's name as the start of the body. That is right until a parameter
is destructured — `async function aiPlaybookVerdicts(key, { text, kind })`
hands back `" text, kind "` as the whole body, so every fact the caller wanted
to read out of it came back missing. It walks the parameter list first now.
This one was worth the most: it is a general-purpose helper, and anything else
reading a function with a destructured parameter was quietly getting nonsense.

**What it looks like fixed.** Against the live HaTi: zero warnings, grip 100%,
ten paid features found instead of nine-with-one-wrong, and a day's ceiling
that is materially higher than before because it now includes an endpoint that
was invisible. The number went up because the old one was wrong.

All four are pinned in `test/verify.mjs`, and the stand-in was reshaped to
match HaTi's current form — including a helper with a destructured parameter, a
tier chosen inside the call, an untagged admin route under `/api/ai/`, and a
tagged route outside it — so the suite exercises each path rather than trusting
the fix.

**Two tests that had pinned a number rather than a property.** Reshaping the
stand-in broke a check asserting "14 screens" and another asserting a
particular file rendered a particular screen. Neither property had stopped
being true; both had been written against the fixture's shape at the time
rather than against the scan, so they now read the real count and pick whatever
file the scan actually described from a screen.

## Nothing was abandoned

Rule 4 of the brief covers the case where an item breaks verification and
cannot be fixed inside that item: revert it in full, log it here as abandoned
with the reason, and carry on. That case did not arise. All seventeen work
items were completed, and `npm run verify` passed before every one of the
seventeen commits.
