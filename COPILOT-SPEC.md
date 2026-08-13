# BUILD SPEC — the Mapper assistant, upgraded

**Audience:** an engineer or a coding agent implementing this against this repository.
**Status:** implementation-ready. Self-contained — every file, function and identifier
named below exists in this repo today, at the path given.

---

## 0. How to use this spec

Read §1–§3, then build in the order in §14. Nine changes, each with its own section,
its own acceptance test, and its own reason for existing.

**Rules for the implementer:**

1. **Do not rebuild what is listed in §1.** The assistant already does most of the hard
   things right. This is an addition, not a rewrite. If a change here would weaken
   something in §1, the change is wrong.
2. **Change 0 (§4) is a live correctness bug, not an enhancement.** Do it first, on its
   own, before anything else in this document.
3. **Change 6 — the drift test (§10) — comes before any new feature that puts a new
   number in front of the model.** It is the test that keeps the assistant and the tabs
   from disagreeing, and it is cheap to write now and expensive to retrofit.
4. Every change ships behind nothing. There is one owner and one deployment; a feature
   flag here would be ceremony. But every change ships with its test in the same commit,
   and `npm run verify` stays green.
5. Where this spec and the repo's conventions disagree about *how* to do something,
   follow the repo. Where they disagree about *what the behaviour should be*, follow
   this spec.

**Stack, as it actually is:** plain ES modules, no build step, no framework, no
TypeScript. `server.mjs` is one Express file. `app.js` is one browser file that runs on
load with no bundler. Tests are Node scripts driving a real browser through Playwright.
Keep it that way. Nothing below needs a dependency that is not already in
`package.json`.

---

## 1. What already exists — do not rebuild it

The assistant in this repo already has the properties most chat features are missing.
Read this section so you do not "add" something that is there.

| Already true | Where |
|---|---|
| Every number the model states, it had to fetch first, from the same scan the tabs draw | `lib/chat.mjs` `runTool()`, `server.mjs` `/api/chat` |
| The model names a chart kind and never supplies its numbers; the page draws it from live records | `CHART_KINDS` in `lib/chat.mjs`, `CHART_RECIPES` in `app.js`, pinned together by `test/copilot.mjs` |
| An invented chart kind draws a visible error card rather than breaking the panel | `app.js` chart hydration, `test/copilot.mjs` |
| Two registers — plain and technical — that change what an answer may leave out, never whether it is true | `registerRules()`, `groundRules()` in `lib/chat.mjs` |
| Flipping the register re-says the answer already on screen, in place, and caches both versions | `restateOnScreen()` in `app.js`, `RESTATE_SYSTEM` in `lib/chat.mjs` |
| Model output is escaped before rendering; link schemes are an allow-list; markup cannot execute | `safeHref()`, `renderMarkdown()` in `app.js`, tests in `test/copilot.mjs` |
| Tone markers `{+}` `{-}` `{!}` `{~}` render as coloured chips | `MARKS`, `colourMarks()` in `app.js` |
| Answers carry source chips that jump to the tab the answer came from | `PANEL_TAB`, `PANEL_LABEL` in `lib/chat.mjs` |
| An error is never written into the conversation the model later reads back | `sendQuestion()` filters `!m.error` before building the payload |
| The API key never reaches the browser; failures are translated into plain English | `lib/anthropic.mjs` `friendlyError()` |
| Rate limit (40 / 15 min) and a daily answer budget (default 200) | `rateLimit('chat', …)`, `CHAT_DAILY_LIMIT` in `server.mjs` |
| "Draft a fix prompt" turns a finding into something pasteable | `lib/draft.mjs` |

That is the foundation. Everything below sits on top of it.

---

## 2. Non-negotiable invariants

Encode these as tests, not as comments. The first four already hold — the tests exist to
stop the changes below breaking them.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | No chart kind may carry numbers from the model, except `quoted` | `test/copilot.mjs` (exists) |
| I2 | Model output is escaped before any markdown pass | `test/copilot.mjs` (exists) |
| I3 | An error is never pushed into `chat.history` as a normal assistant turn | `test/copilot.mjs` (exists) |
| I4 | Every path that reaches Anthropic carries the register, read at call time | `test/copilot.mjs` (exists) |
| I5 | Every number the assistant can be handed equals the number the tab draws | §10 drift test — **new** |
| I6 | A conversation restored from storage is byte-identical to the one that was saved, minus anything transient | §7 — **new** |
| I7 | `max_tokens` is never sized to the expected answer length | §4 — **new** |
| I8 | The assistant is never told which tab you are on by the client alone; the server validates the tab name against the real list | §5 — **new** |

---

## 3. File map

Everything below either edits a file that exists or adds one beside it. No directories
are created.

```
lib/
  chat.mjs          §4 §5 §8 §11   registers, tools, the system prompt, the split
  anthropic.mjs     §4 §9          the one call to Anthropic
  drift.mjs         —              (unrelated: version drift, do not confuse with §10)
server.mjs          §4 §5 §8 §9    /api/chat
app.js              §5 §6 §7 §9 §13 the panel
index.html          §6 §7 §13      the panel's markup and styles
test/
  copilot.mjs       all            the existing panel test — extend, do not replace
  chatdrift.mjs     §10            NEW — the drift test
  chateval.mjs      §12            NEW — the answer eval set
```

Two files this spec named turned out to be wrong, and are not created:

- **`lib/chatcache.mjs`** — the split in §8 lives in `lib/chat.mjs` beside the prompt
  it splits. A second file would have separated the two halves of one briefing from
  each other, which is the opposite of the point.
- **`data/copy.js` for the starter questions in §6** — that file is HaTi's
  hand-maintained phrasebook, describing HaTi's own screens, and it is a server module
  that the browser never receives (`server.mjs` serves exactly three files). The
  questions are the Mapper's own interface copy and live in `app.js`.

---

## 4. CHANGE 0 — `max_tokens` is now a shared budget. Fix this first.

> **DONE.** Shipped in the commit that follows this document. Kept here in full
> because it explains a failure that will look like a model problem the next time
> something similar happens, and because §4.2's rules still bind anyone tuning
> these numbers later.

### 4.1 What is wrong

`server.mjs` sends, per step of the tool loop:

```js
max_tokens: register === 'technical' ? 3000 : 1600
```

and sends no `thinking` field at all. That was correct against the previous generation of
Sonnet, where omitting `thinking` meant no thinking happened.

On `claude-sonnet-5` — which is `DEFAULT_MODEL` in `lib/anthropic.mjs` and therefore what
this runs on today — **omitting `thinking` runs adaptive thinking**, and `max_tokens` is a
hard ceiling on thinking *plus* the visible answer together. A wide question in the plain
register has 1600 tokens for both.

The failure is not loud. There is no error. The model thinks, runs out of budget, and the
turn ends with `stop_reason: "max_tokens"` — which `server.mjs` does not check — so the
loop either delivers a truncated answer or falls through to
`'I could not finish working that one out.'` That message reads as the model being
confused. It is the ceiling.

### 4.2 What to do

In `server.mjs`, in the `/api/chat` loop:

- Raise `max_tokens` to **8000** in both registers. It is a ceiling, not a target — a
  short answer still costs what a short answer costs. Do not tune it down to "what a
  plain answer needs"; that is exactly the mistake being fixed.
- Set `output_config: { effort: 'medium' }` explicitly, and sweep it in §12. `effort` is
  the honest lever for cost and latency; `max_tokens` is not.
- After each Anthropic response, **check `stop_reason` before reading the content.**
  - `'max_tokens'` → the answer is truncated. Do not deliver it as if it were complete.
    Return the `upstream`-class error with the message *"That answer ran long and got cut
    off. Try asking for one part of it."*
  - `'refusal'` → the model's safety classifiers declined. `stop_details.category` says
    why, and may be `null`. Do not read `content` — it is empty or partial. Return a
    friendly error (§9). Never write a partial refusal into the thread.
- Do **not** send `temperature`, `top_p`, `top_k` or `budget_tokens`. All four are
  rejected on this model. None are currently sent — keep it that way.

In `lib/anthropic.mjs`, nothing changes except a comment: note that `max_tokens` covers
thinking as well as the answer, so nobody helpfully shrinks it again.

### 4.3 Acceptance

- A deliberately wide question in the plain register ("explain everything on the control
  tower and what each number means") returns a complete answer, not the
  could-not-finish message.
- `test/copilot.mjs` gains a case: the stand-in returns `stop_reason: 'max_tokens'`, and
  the panel shows the cut-off error as a transient red line, not as a bubble, and
  `chat.history` gains no assistant turn.
- A grep of `server.mjs` finds no `temperature`, `top_p`, `top_k` or `budget_tokens`.

---

## 5. CHANGE 1 — the assistant knows which tab you are looking at

### 5.1 Why

You can be staring at the Doors tab, click the assistant, and ask "is this actually a
problem?" — and it has no idea what *this* is. Every other grounding decision in this
product is about removing ambiguity; this is the largest remaining piece of it, and it is
one field on a request.

### 5.2 Client

`app.js` already knows the active tab: the pill row uses `data-p` on each button, and the
values are exactly `tower`, `launch`, `screens`, `cost`, `public`, `changes`, `blast`,
`data`, `weight`, `settings`.

Add a `currentTab()` reader beside `currentRegister()`, following the same rule that file
already insists on: **read it at call time, never capture it into a variable at load.**
The reason is the same one written at length above `currentRegister()` — a captured value
freezes whichever tab happened to be open when the page loaded, and every switch after
that changes the highlight and nothing else.

`askServer()` is the single place every request goes through. Extend it:

```js
return send('POST', '/api/chat', Object.assign(
  { register: currentRegister(), screen: currentTab() }, body || {}));
```

That covers questions, restates and drafted fix prompts in one edit, exactly as the
register already is.

### 5.3 Server

In `server.mjs`, validate rather than trust. The tab name arrives from a browser and ends
up inside a prompt:

```js
const SCREENS = { tower: 'Control tower', launch: 'Ready?', screens: 'Screens',
  cost: 'Money', public: 'Doors', changes: 'Changes', blast: 'What breaks what',
  data: "What's stored", weight: 'Getting bulky', settings: 'Settings' };
```

Anything not a key of `SCREENS` becomes `null`, and a `null` screen renders no screen
section at all. Never interpolate the raw string.

### 5.4 Prompt

`buildSystem()` in `lib/chat.mjs` takes a new `screen` argument and emits, as the **first**
section after the register block — before the ground rules, because it changes what the
question means:

```
WHERE THE OWNER IS LOOKING
They have the "<label>" tab open. Answer for what is on that tab first, then widen if
widening helps. If the question makes no sense for this tab, answer the question rather
than the tab — never refuse because of where they are standing.
```

Plus one line per tab, appended, telling the model what that tab actually answers. Take
the wording from the table at the top of `README.md` — it is already written, already
correct, and already the owner's own vocabulary. For example:

```
The "Doors" tab lists everything that works without logging in, with the code's promise
about each one beside what the live site actually did when the Mapper knocked.
```

The tab does **not** restrict which tools the model may call. It is context, not a
filter — a question asked on the Money tab may legitimately need the launch checklist.

### 5.5 Acceptance

- `test/copilot.mjs` gains a case: open the panel from the Doors tab, ask anything, and
  assert the stand-in received a body with `screen: 'public'` and a system prompt
  containing `WHERE THE OWNER IS LOOKING` and the word `Doors`.
- Switch to Money, ask again, and assert the second body says `cost`. This is the same
  shape as the existing register-is-not-frozen test, and for the same reason.
- Post `{"screen":"<script>"}` directly to `/api/chat` and assert the system prompt
  contains no screen section and no angle bracket.

---

## 6. CHANGE 2 — starter questions per tab, and your own recent ones

### 6.1 Why

An empty box is a hard thing to talk to. The `WELCOME` text in `app.js` already explains
what the assistant can do, in prose; nobody reads prose in a chat panel before typing.
Four clickable questions get a first answer on screen in one click, and the first answer
is what teaches the panel's shape.

### 6.2 The questions

New export in `data/copy.js` — that file is already where the product's human-written
wording lives, so this belongs there rather than in `app.js`:

```js
export const CHIPS = {
  tower:    ['📊 Is anything wrong right now?', '💰 What is this costing me?',
             '⚠️ What should I look at first?', '🔍 What could the scanner not read?'],
  launch:   ['🎯 What is left before I can demo?', '⚠️ What is blocking real customers?',
             '💾 Am I safe if something breaks?', '📋 Which ticks have gone stale?'],
  screens:  ['📊 Which file is doing too many jobs?', '🔍 What does each screen do?',
             '⚠️ Which screens share a file?', '💡 Where would a change land hardest?'],
  cost:     ['💰 What is driving today’s burn?', '📊 Which feature costs the most per use?',
             '⚠️ Is any paid feature unused?', '🔍 Is this an estimate or a bill?'],
  public:   ['⚠️ Which open door is the risky one?', '🔍 What is genuinely unguarded?',
             '📊 Has anything opened up lately?', '💡 What would I do about it?'],
  changes:  ['📊 What changed since yesterday?', '🔍 What has been moving all week?',
             '⚠️ Did anything change that worries you?', '💡 Changes vs commits — what is the difference?'],
  blast:    ['⚠️ What could break something already signed?', '🔍 What depends on this?',
             '📊 Which piece of data is riskiest to change?', '💡 Is this map still accurate?'],
  data:     ['📊 What is actually stored?', '🔍 What is hidden inside a blob?',
             '⚠️ Is anything stored that should not be?', '💡 What do these tables do?'],
  weight:   ['📊 Which files are getting hard to work on?', '🔍 What is published but never used?',
             '⚠️ Is anything growing fast?', '💡 What should I split up?'],
  settings: ['⚙️ Are my alert settings sensible?', '🔍 Where is my data actually kept?',
             '💰 How much has the assistant cost today?', '💡 What should I turn on?'],
};
```

Every one of these is answerable from a tool that already exists. Do not add a question
the assistant cannot answer — a starter question that produces "I can't see that from
here" teaches the opposite of what it was for.

### 6.3 Recent questions

Keep the last **8** questions per tab, in a new `recentByScreen` map on the store (§7),
deduplicated, newest first. Show up to **4** under the starter chips, behind a divider
labelled `Recent on <tab>`, styled with a dashed border and a `↺ ` prefix, and elided at
42 characters. They are shown only when the active conversation is empty, alongside the
starters.

### 6.4 Wiring — the one rule that matters

Chip text and recent-question text are **untrusted input**. The recent list is persisted
and comes back from storage; the starter list is ours today and may not be tomorrow.
Carry the text in a `data-` attribute and read it through `dataset` in a delegated click
handler. **Never splice either into an inline handler string.** This repo already holds
that line everywhere else — `test/copilot.mjs` asserts no element carries an `on*`
attribute — and the same test will catch a violation here for free.

### 6.5 Acceptance

- The chips shown change when the tab changes, without reopening the panel.
- Clicking a chip sends exactly its text and the chips disappear.
- `test/copilot.mjs`: ask a question, clear the conversation, and assert it reappears as
  a recent chip on that tab and not on another tab.
- The existing no-inline-handlers assertion still passes with a persisted question
  containing `"` and `<`.

---

## 7. CHANGE 3 — the conversation survives

### 7.1 Why

`app.js` holds the whole conversation in `var chat = { history: [], … }`. A refresh loses
it. So does a redeploy of the page. The panel is the only part of this dashboard that
forgets everything the moment you blink, and the answers in it are often the most
considered thing on the screen.

There is a second, worse case. Ask a wide question, close the panel because the answer is
taking a minute, and the answer lands into a closed panel with nothing to say it arrived.
Reopen and the question is gone too.

### 7.2 The store

Keep `chat` as the single source of truth and give it shape:

```js
var chat = {
  conversations: {},        // id -> { id, title, messages, unread, lastAt }
  activeId: null,
  busy: false,              // per-conversation once there is more than one
  seq: 0,
  recentByScreen: {},       // ScreenKey -> [string], max 8, newest first
};
```

**Persisted** to `localStorage` under `hati-mapper.chat`: `conversations`, `activeId`,
`recentByScreen`. Follow the existing key convention (`hati-mapper.answerRegister`,
`hati-mapper.chatExpanded`) and the existing habit of wrapping every `localStorage` call
in `try`/`catch` — private mode must degrade to in-memory, never throw.

**Never persisted:** anything in flight, and any error. An error persisted as an
assistant turn gets re-sent as context on every later question and quietly poisons the
conversation. `sendQuestion()` already filters `!m.error` out of the outgoing payload;
persistence must not undo that. Store errors in a separate transient map keyed by
conversation id and clear it on the next send.

**Caps.** Keep at most **10** conversations and at most **40** messages each, dropping
oldest first, and cap each stored message at 20 000 characters. `localStorage` is small
and shared, and a chart-heavy technical answer is not.

**Titles.** The first user message, trimmed to 48 characters. No model call — a title is
not worth an Anthropic request.

### 7.3 The rail

A horizontal row of conversation pills above the message list, matching the tab pills'
scroll behaviour: `overflow-x: auto`, a 3px scrollbar, active pill filled with the accent.
A `+` at the left starts a new conversation. The existing `askClear` button changes
meaning from *delete this conversation* to *delete this conversation*, which is now a
smaller and safer act because the others survive.

### 7.4 Answers landing while you are away

- Sending marks the conversation pending. Pending state lives in memory only — it is a
  fact about a request, not about the conversation.
- If the answer arrives while the panel is closed, minimised, or showing a different
  conversation, increment that conversation's `unread` and light the badge on
  `askLaunch`. Reuse the unread-badge styling from the existing warnings circle so a
  number means the same thing in both places.
- Opening a conversation clears its unread.
- If the panel is closed mid-request, the request still completes and the answer still
  lands. Do not abort on close.

### 7.5 Re-rendering

`renderFeed()` already rebuilds the whole feed from state on every change, and already
clears `chartSpecs` for messages that are gone. Keep exactly that. Every chart instance
must be destroyed before the markup that holds its canvas is replaced — this is already
handled by the `seenCharts` sweep in `renderFeed()`; switching conversations must go
through the same path rather than around it.

### 7.6 Acceptance

- Ask a question, refresh the page, reopen the panel: the question and the answer are
  both there, both registers cached if both were fetched, sources chips still clickable,
  charts redrawn from live data.
- I6: a saved-then-restored conversation is deep-equal to the original, minus pending and
  error state.
- Ask, close the panel mid-flight, reopen after the answer lands: the answer is there and
  the badge showed a 1.
- Fill storage past the caps and assert the oldest conversation is dropped rather than
  the write failing.
- With `localStorage` throwing on every call, the panel still works for the session.

---

## 8. CHANGE 4 — split the briefing so it caches

### 8.1 Why, with the numbers to check

Every question runs a tool loop of up to 5 steps (`for (let step = 0; step < 5; step++)`
in `server.mjs`). Each step re-sends the entire tool array and the entire system prompt.
Both are large: seven tools with long descriptions, plus the register block, the ground
rules, the chart rules with all eleven kinds listed, and the current-state briefing.
Today every one of those steps pays full input price for all of it.

Anthropic's prompt cache is a **prefix match**, rendered in the order `tools` → `system` →
`messages`. Content before the last `cache_control` breakpoint is cached; a single
changed byte anywhere in the prefix invalidates everything after it. A cache read costs
about a tenth of a normal input token; a cache write costs about 1.25× for the default
five-minute lifetime. Two reads pay for one write.

The tool loop is the point. Steps 2 through 5 of a single question happen seconds apart,
so they read the cache step 1 wrote — the saving lands *within one question*, not only
across a session. A follow-up question inside five minutes reads it again.

`buildSystem()` currently interpolates the live counts, the scan time and the money
headline directly into the middle of one string. That single fact is what makes the whole
prompt uncacheable.

### 8.2 The split

New file `lib/chatcache.mjs`, exporting two functions that between them produce what
`buildSystem()` produces today:

```js
export function stablePrefix(register);   // byte-identical for a given register, forever
export function liveBlock(ctx);           // rebuilt every request
```

**`stablePrefix(register)` contains** — everything that does not depend on this
workspace, this scan or this moment:

- who the assistant is and who it is talking to
- `registerRules(register)`
- `groundRules()`
- `chartRules()` — the kinds list is a constant
- `WHERE THE OWNER IS LOOKING` guidance *in general* (see §8.4)
- the money-figures explanation, the changes-versus-commits section, the scope and
  boundaries section, the glossary (§11)

**`liveBlock(ctx)` contains** — everything that moves:

- the current counts, the scan time, the code version, staleness
- the change-log status line
- the money headline figure
- whether the live HaTi is reachable
- the scan's own warnings
- the current tab's label

`buildSystem()` stays as the assembly point and returns
`{ prefix, live }` rather than a string, so every existing caller changes in one place.

### 8.3 The request

In `server.mjs`, send `system` as an array of two blocks with the breakpoint on the first:

```js
system: [
  { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: live },
],
```

`tools` renders before `system`, so a breakpoint on the first system block caches the
tools **and** the stable prefix together. That is the whole win; nothing further is
needed.

The `draft` and `restate` blocks (`draftSystem()`, `RESTATE_SYSTEM`) go into the **live**
block, not the prefix. They are present on some requests and absent on others; putting a
conditional section in the prefix would create a separate cache entry per combination and
defeat the purpose.

### 8.4 The rules that keep it cached

These are not style preferences. Break one and the cache silently never hits.

1. **Never interpolate the register into one prefix string.** Two registers means two
   prefix values and two cache entries — build them as two separate constants, not one
   template. `lib/chat.mjs` already insists every register-dependent thing be a function
   called at call time; keep that, and let each call return one of two frozen strings.
2. **Never put the date, the scan time, the tab, the commit, a count, or anything
   workspace-specific into the prefix.** The general "answer for the tab in front of
   them" guidance is stable and belongs in the prefix; the tab's *name* moves and belongs
   in the live block.
3. **Do not vary the tool array per request** beyond the two register variants that
   already exist. Tools render first; changing one invalidates everything.
4. **Do not change `AI_MODEL` mid-conversation.** Caches are per-model.

### 8.5 Two things this repo must not copy from elsewhere

- **Do not move the live block into a `{ role: 'system' }` message inside `messages`.**
  Mid-conversation system messages are not supported on `claude-sonnet-5`, which is this
  product's default model. It would 400. The two-block `system` array above achieves the
  same caching without that dependency.
- **Do not size the prefix down to hit a minimum.** The minimum cacheable prefix on
  Sonnet 5 is 1024 tokens; the tools array alone is comfortably past it, and the prefix
  is several times that. Verify rather than assume (below).

### 8.6 Measure it

Do not report a saving you have not measured.

- Log `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens` per step,
  alongside the existing latency logging. **Do not log the prompt, the live block, the
  question or the answer** — this is the owner's own platform data and `server.mjs`
  already, correctly, logs none of it.
- Surface the totals on the Settings card beside the existing daily budget line, in the
  Mapper's own idiom: *"Today: 41 questions. 78% of what the assistant read was served
  from cache."*
- Expected shape, to be confirmed rather than trusted: step 1 of a question writes the
  cache, steps 2–5 read it, and a multi-step question's fixed overhead drops by roughly
  half to two-thirds. If `cache_read_input_tokens` is zero on step 2 of any question,
  something in the prefix is moving — diff two consecutive prefixes byte for byte and
  find it.

### 8.7 Acceptance

- `test/copilot.mjs`: assert that two consecutive requests in the same conversation, and
  two steps of the same tool loop, send a byte-identical first `system` block, and that
  the block carries `cache_control`.
- Assert the first system block contains no digit that came from the scan, no ISO
  timestamp, and no tab label.
- Assert flipping the register produces a different prefix, and flipping back produces
  the first one again, byte for byte.
- Against the real API: `cache_read_input_tokens > 0` on the second step of any question
  that uses a tool.

---

## 9. CHANGE 5 — say what you are doing while you do it

### 9.1 Why

`app.js` has a genuinely nice waiting message that walks from *"Reading your question"*
through *"Still going — a wide question takes a few more looks"* to *"Still going. A long
answer can take about a minute"*. It is the polite version of a blank wait, and every word
of it is a guess. The server knows exactly what the model is doing — it is running a tool
loop and it can see which tool — and tells the browser nothing until the whole thing
finishes.

### 9.2 Stage one — real progress, no streaming

This is the larger share of the benefit for a fraction of the work, and it is honest
where the current ticker is not.

Change `/api/chat` to respond with `Content-Type: text/event-stream` and emit:

```
event: step   data: {"tool":"get_panel","label":"Reading the Money tab"}
event: done   data: { …exactly the JSON body the route returns today… }
event: error  data: {"code":"…","message":"…"}
```

One `step` per tool the model actually calls, emitted from inside the existing loop where
`toolsUsed.push(t.name)` already happens. The label comes from a fixed map in
`lib/chat.mjs` beside the tools themselves, so the wording lives next to the thing it
describes:

| Tool | Label |
|---|---|
| `get_overview` | Getting the headline numbers |
| `get_panel` | Reading the <panel> tab |
| `get_changes` | Reading the change log |
| `search_map` | Searching for "<query>" |
| `get_launch_readiness` | Reading the launch checklist |
| `get_live_usage` | Asking the live HaTi what it is using |

`get_panel` and `search_map` take their detail from the tool input, which the model
supplies — so **escape it** before it reaches the DOM. It goes through the same `esc()`
every other model-supplied string does, and it is truncated to 40 characters.

The client replaces the guessed ticker with the real one, keeping the existing behaviour
of updating the label in place rather than re-rendering the feed — a full repaint every
second throws away the scroll position of someone reading the answer above.

Keep one guessed line: if no `step` has arrived for 20 seconds, fall back to *"Still
going — a wide question takes a few more looks"*. Silence still needs an explanation.

### 9.3 Stage two — stream the words

Only after stage one works.

The answer does not arrive as ordinary text. It arrives as the `answer` field inside the
model's call to `deliver_answer`, so on the wire it is a partial JSON string arriving as
`input_json_delta` events. Two consequences:

- Set `stream: true` on the Anthropic request and parse the SSE body — `message_start`,
  `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`
  (which carries `stop_reason` and usage), `message_stop`.
- Set `eager_input_streaming: true` on the `deliver_answer` tool definition so its input
  streams as it is produced rather than arriving whole. This is generally available and
  needs no beta header.
- Incrementally recover the `answer` string from the partial JSON and emit it as
  `event: delta`. Buffer a few tokens before painting — a DOM write per token is worse
  than a slightly chunky one.

**Do not render a partial answer through the chart pipeline.** A half-arrived
```` ```monitor-chart ```` block must not hydrate. Render deltas as escaped plain text in
a streaming area, and run the full `renderMarkdown()` → chart hydration path exactly once,
on `done`, on the committed message. The final render is the authoritative one; the
stream is a preview.

**Never commit a partial answer to history.** If the connection drops mid-stream, discard
the partial and show the transient error. A truncated answer stored as a real one gets
re-sent as context forever.

### 9.4 Errors over SSE

`lib/anthropic.mjs` `friendlyError()` already maps status codes to plain English. Extend
it with two cases and give each a code the client can switch on:

| Condition | code | Message |
|---|---|---|
| 401 | `auth` | The Anthropic key was rejected. *(exists)* |
| 429 from Anthropic | `rate_limited` | Anthropic is rate-limiting the key right now. *(exists)* |
| Local rate limit or daily budget | `throttled` | *(exists, keep the existing wording — it explains why the limit exists)* |
| `stop_reason === 'refusal'` | `refused` | **new** — "I can't help with that one. Try asking it a different way, or ask about a part of your platform." |
| `stop_reason === 'max_tokens'` | `truncated` | **new** — "That answer ran long and got cut off. Try asking for one part of it." |
| 5xx / 529 | `upstream` | *(exists)* |
| Stream drops mid-answer | `interrupted` | **new** — "The connection dropped. Ask again." |

All of them render as a transient red line styled as system text, cleared on the next
send, and **none of them is ever pushed into `chat.history` as an assistant turn.** This
is already how the panel behaves; the point of listing it here is that SSE gives you a new
and tempting place to get it wrong.

### 9.5 Acceptance

- `test/copilot.mjs`: script the stand-in to call two tools before delivering, and assert
  the panel showed both step labels in order.
- A `search_map` step whose query is `<img src=x onerror=alert(1)>` renders as text. The
  existing no-`on*`-attributes sweep must still pass.
- Killing the connection mid-stream leaves no assistant message in `chat.history` and
  shows the `interrupted` line.
- `stop_reason: 'refusal'` from the stand-in produces the `refused` line and no bubble.

---

## 10. CHANGE 6 — the drift test

**This is the most valuable thing in this document. Build it before Changes 7–9.**

> **DONE** — `test/chatdrift.mjs`, wired into `npm run verify`. It found a real bug
> on its first run, described in §10.5.
>
> One thing in §10.2 below was written wrong and is corrected in §10.3: a tool
> result reaches the model as `JSON.stringify(out)`, which is a lossy door.
> `undefined` disappears, `NaN` and `Infinity` both arrive as `null`. None of the
> three can be found by looking for itself on the far side, so the "walk it for
> NaN and undefined" plan does not work over the wire. What replaced it catches
> the same failures by their fingerprint instead.

### 10.1 Why

`README.md` makes a promise about the control tower: *"a summary, never a second source.
Every figure on it is read from the same scan the panels below are drawn from, so the two
can never disagree; the verification suite asserts exactly that."*

The assistant is the one reader of this data that is **not** pinned that way. It is also
the reader most likely to be believed, because it answers in sentences. An assistant that
quietly disagrees with the tab beside it is worse than no assistant, and nothing today
would catch it.

Most of `runTool()` reads the same cached `scan` the tabs render, so most of it is safe by
construction. The drift surface is where the assistant and the tabs reach the data by
*different routes*:

| Number | Assistant's route | The tab's route |
|---|---|---|
| Launch verdict, needle, counts | `evaluateLaunch(launchContext())` inside `/api/chat` | `GET /api/launch` |
| Change count and window | `history.changes(hours)` via `get_changes` | `GET /api/changes`, `GET /api/watch` |
| Live caps and requests today | `readPulse()` via `get_live_usage` | `GET /api/pulse` |
| Today's burn | `s.cost.dailyMixedUsd` in the briefing | the tower tile and the Money tab |
| Scanner grip % | not currently exposed to the assistant at all | the tower card and `GET /api/trends` |
| Files over the line, orphans | `get_panel('weight')` | the Getting bulky tab |

### 10.2 The test — `test/chatdrift.mjs`

Runs against the same fixture the other tests use (`test/source.mjs`, `lib/fixture.mjs`),
with no browser and no Anthropic. It boots the server, then for each row asserts that the
value the assistant would be handed equals the value the tab is drawn from:

```js
const rows = [
  ['launch verdict',      () => tool('get_launch_readiness').verdict,
                          () => api('/api/launch').verdict],
  ['items outstanding',   () => tool('get_launch_readiness').outstanding.length,
                          () => api('/api/launch').items.filter(i => !i.done).length],
  ['change count (72h)',  () => tool('get_changes', { hours: 72 }).changes.length,
                          () => api('/api/changes?hours=72').rounds.length],
  ['open doors',          () => tool('get_overview').addressesWithNoLogin,
                          () => api('/api/scan').public.routes.length],
  ['today’s burn',   () => briefingNumber('Today’s burn'),
                          () => api('/api/scan').cost.dailyMixedUsd],
  ['files over the line', () => tool('get_panel', { name: 'weight' }).filesOverTheLine.length,
                          () => api('/api/scan').weight.overThreshold],
  ['ai features',         () => tool('get_overview').aiFeatures,
                          () => api('/api/scan').ai.features.length],
  // one row per number that can appear in an answer
];
```

### 10.3 The three assertions that are not about any single number

**As built**, correcting the plan in §10.2:

- **Nothing went missing on the way through.** `JSON.stringify` deletes an `undefined`
  key outright and turns `NaN` and `Infinity` into `null`, so none of the three is
  findable by looking for itself once the result has crossed to the model. Both leave the
  same fingerprint, though — a fact the model needed and did not get — so the test looks
  for that instead, in two parts. Every tool declares the keys it always carries, and a
  missing one fails: that catches `undefined`. Every field the model will read as a
  number and put in a sentence must be a finite number, and a `null` there fails: that
  catches `NaN` and `Infinity`. A `null` anywhere else is left alone, because "not
  detected" is a real and deliberate answer all over this product.
- **Stable.** Call every tool twice against an unchanged scan and assert byte-identical
  JSON. A tool whose output moves without the data moving cannot be reasoned about.
- **Empty is a real answer.** Against a near-empty workspace — a temp directory holding
  two almost-blank files — assert the scan succeeds, `get_changes` returns
  `nothingChanged: true` rather than an error, `get_launch_readiness` returns a verdict,
  and `get_live_usage` says *why* it cannot reach HaTi rather than reporting nothing. The
  prompt already tells the model an empty change log is a real and reportable answer; the
  tools have to actually produce one.

### 10.4 The rule that keeps it honest

**Adding a number to the assistant's reach without adding a drift row fails review.** Say
so in the file's header comment, in the repo's own voice, so the next person editing
`runTool()` reads it before they add a field.

### 10.5 What it found on its first run

`scanPublic()` in `lib/scan.mjs` returns early when HaTi's `server/server.js` cannot be
read, and that early return was missing `totalRoutes` — so `scan.public.totalRoutes` was
`undefined` rather than a number, on exactly the path the README describes as the way this
product decays: *"a part of HaTi that has gone"*.

Three consumers, one of them defended:

- The control tower's Open doors card printed **"of undefined server routes carry no login
  check"** at the owner.
- The Doors tab's lede did the same.
- A third site at `app.js:1706` was already guarded with `|| 0` — which is how these
  things always look: someone hit it once, patched where it hurt, and the other two sites
  kept the bug.
- On the assistant's side it was worse than visible. The key vanished from the JSON
  entirely, leaving the model with a count of open doors and nothing saying what it was a
  count *of*.

Fixed as `totalRoutes: null` — deliberately not `0`, because `0` claims HaTi has no
addresses and what actually happened is that the Mapper could not tell — with both render
sites saying so in words, and `?? null` in the tool so the key is always present.

### 10.6 Acceptance

- `node test/chatdrift.mjs` passes on the full fixture and on a near-empty one. **120
  checks, all passing.**
- It is in the `verify` script, before `test/copilot.mjs`.
- Deliberately break one row — return `Math.round()` of a value the tab shows unrounded —
  and it fails with a message naming the row and both figures.

---

## 11. CHANGE 7 — the glossary of words that mean two things

### 11.1 Why

`lib/chat.mjs` already does this once, at length and very well: the *"TWO DIFFERENT THINGS
ARE CALLED CHANGES"* section, which spends a paragraph making sure the model never reports
a commit count as a change count. That section exists because the confusion actually
happened and produced an answer that contradicted the dashboard.

That is one instance of a general problem. This product has at least five more overloaded
words, and each one is a future version of the same bug.

### 11.2 The glossary

Goes in the **stable prefix** (§8), after the ground rules. Same shape as the existing
changes-versus-commits section: state the distinction, then state the routing rule, then
state the fallback.

```
WORDS IN THIS PRODUCT THAT MEAN MORE THAN ONE THING
Never guess which one the owner means.

(1) "CHANGES" is one of:
  · The change log — what the Mapper observed by comparing one of its own scans with the
    next. This is what the calendar counts and what "what changed" means. Only
    get_changes gives you this.
  · Commits — the git log, messages someone typed when saving work. A different number
    counting a different thing.

(2) "COST" or "BURN" is one of:
  · Today's burn — the Mapper's own estimate of what a full day at HaTi's caps would
    cost, priced from data/pricing.js. A roof, not a bill.
  · The worst case — the same estimate with nothing held back.
  · Live usage — how many AI requests the running HaTi has actually made today. A count,
    not money. No dollar figure ever crosses from the running site.

(3) "GAPS" is one of:
  · Known gaps — things in HaTi written down as not finished.
  · Things the scan could not work out — places the Mapper failed to read HaTi, which say
    nothing about whether HaTi is finished.
  · Out-of-date warnings on the hand-written dependency map.

(4) "OPEN" or "A DOOR" is one of:
  · An address that works without logging in. Many of these are fine — they serve the app
    page, or check their own secret, or need an unguessable code in the link.
  · An address with nothing guarding it at all. This is the one that matters.
  Never call the first one a problem without saying which guard it has.

(5) "READY" is one of:
  · Ready to demo — the lower bar.
  · Ready for real customers — the higher one.
  These have separate counts and separate blocking lists. Say which you mean.

(6) "SCANNER GRIP" is how much of HaTi the Mapper could read. It is a fact about the
    Mapper, not about HaTi's health. A falling grip means the Mapper is going blind, not
    that HaTi is getting worse.

ROUTING
  · On the Money tab, "cost" means the estimate unless they say "actually" or "really".
  · On the Changes tab, "changes" always means the change log.
  · On the Ready? tab, "ready" means whichever gate is currently blocking.
  · "How many" plus anything in this list: say which one you counted, in the same
    sentence as the number.
  · WHEN IT IS STILL AMBIGUOUS, ASK BEFORE QUOTING A NUMBER. One short question. Never
    guess between two figures that differ.
```

The existing standalone changes-versus-commits section stays. It is longer, more
insistent, and earned its length; the glossary entry cross-references rather than replaces
it.

### 11.3 Acceptance

Behavioural, so it belongs in §12's eval set rather than in a unit test. The specific
cases:

- "How many changes have there been?" asked on the Changes tab with an empty watch log
  never reaches for the commit count.
- "What is this costing me?" states the figure as the Mapper's own estimate, in the same
  sentence.
- "How many doors are open?" gives the count and distinguishes guarded from unguarded.
- "Am I ready?" either asks which gate, or answers both and says so.

---

## 12. CHANGE 8 — test that the answers are right

### 12.1 Why

`test/copilot.mjs` is 628 lines and very good at structure: the right briefing goes out,
the register is never frozen, an unknown chart kind draws a card, injected markup renders
as text, only the first chart is drawn. Every one of those is a bug that already happened.

What no test asserts is whether the answers are **true**. Ask about a database table that
does not exist, and nothing today would notice if the assistant invented one.

### 12.2 Shape — `test/chateval.mjs`

Reuse the machinery that already exists. `test/copilot.mjs` boots the real server against
a stand-in Anthropic at `ANTHROPIC_BASE_URL` with a scripted reply queue; the eval set
does the same, but runs against the **real** API, gated behind an environment variable so
`npm run verify` stays free and offline:

```
CHAT_EVAL_KEY=sk-ant-… node test/chateval.mjs
```

30–40 cases across the two fixtures. Every case asserts a **behaviour**, never wording.

| Category | Cases | Assertion |
|---|---|---|
| Numeric fidelity | 6 | Every number in the answer appears in what the tools returned, allowing rounding to one decimal place |
| No invention | 5 | Asked about a table, screen, feature or competitor-style thing that is not in the scan, the answer says it cannot see it and does not name one |
| Ambiguity | 6 | Each glossary word from §11 asked bare; the answer either asks, or names which sense it used, in the same sentence as the number |
| Changes vs commits | 3 | With an empty watch log, the answer says nothing was observed and never substitutes a commit count |
| Money framing | 3 | Any dollar figure is described as the Mapper's own estimate, never as a bill or as live data |
| Boundary | 3 | Asked about a contract, a client or a value inside HaTi, the answer says it can see the machinery and never the paperwork |
| Chart discipline | 4 | At most one chart; no unknown kind; every `quoted` value also appears in the narrative |
| Register | 4 | A plain answer contains no term from a jargon list without a gloss in the same sentence; a technical answer keeps every caveat the plain one had |
| Empty state | 3 | On a near-empty fixture, guidance, not invented numbers |
| Consistency | 3 | An eight-turn conversation does not contradict itself; a mid-conversation tab switch is reflected in the next answer |

Run each case at `effort` `low`, `medium` and `high` and pick the lowest tier that holds
the pass rate. Target ≥95%. Record the chosen tier in `server.mjs` with a comment saying
which sweep chose it and when — an unexplained magic setting is the thing this repo is
otherwise very good at not having.

### 12.3 Acceptance

- The set runs, reports per-category pass rates, and writes a transcript to a temporary
  directory that is gitignored.
- A deliberately broken prompt — remove the changes-versus-commits section — drops the
  changes category below its threshold. If it does not, the cases are too weak.

---

## 13. CHANGE 9 — three small ones

### 13.1 Rescue a badly fenced chart

`renderMarkdown()` in `app.js` recognises exactly ```` ```monitor-chart ````. A model that
writes ```` ```json ```` around a valid chart spec produces a wall of raw JSON in the
owner's face. That is a bad outcome for a formatting slip.

Add two rescue passes after the exact-fence pass, in this order:

1. A fenced block tagged `json`, `JSON`, `js` or nothing, **only** when its body contains
   `"kind"` set to one of the kinds in `CHART_KINDS`.
2. After `innerHTML` is set, query for `pre` elements whose content parses to an object
   with a known `kind`, and hydrate those in place.

Both go through the same `validateChartSpec` path and the same one-chart-per-reply rule
that already exists. A rescued block that fails validation draws the same error card any
other bad block draws. The owner must never see raw JSON.

### 13.2 Phone keyboard

The panel is `position: fixed; top: 0; bottom: 0`. On iOS the layout viewport does not
shrink when the keyboard opens, so a bottom-anchored input box ends up underneath it.

Under `max-width: 768px`, anchor the panel to the top instead and drive its height from
the `visualViewport` API on both `resize` and `scroll`:

```css
#ask { width: 100vw !important; border-left: none !important;
       top: var(--adv-vv-top, 0px) !important; bottom: auto !important;
       height: var(--adv-vvh, 100dvh) !important; }
#ask .adv-textarea { font-size: 16px !important; }   /* under 16px, iOS zooms */
#ask .ask-messages { overscroll-behavior: contain; min-height: 0; }
#askExpand { display: none !important; }
```

Top-anchoring is required, not cosmetic. Anything else buries the input.

### 13.3 A real welcome

Once the starter chips exist (§6), the `WELCOME` string is doing a job the chips do
better. Cut it to two sentences and let the chips carry the rest. Keep the boundary
sentence — *"I never see the contracts inside HaTi"* — verbatim. It is the single most
important thing the panel says, and it should be the last thing before the chips.

---

## 14. Build order

Each task ends with something you can check.

| # | Task | Acceptance |
|---|---|---|
| 0 | ~~**§4 — `max_tokens` and `stop_reason`**~~ **— done** | A wide plain-register question returns a complete answer; truncation and refusal say which they were, and neither is fed back to the model |
| 1 | ~~**§10 — the drift test**~~ **— done** | `node test/chatdrift.mjs` passes on both fixtures; it is in `npm run verify`; breaking a row fails it |
| 2 | ~~**§5 — the tab the owner is on**~~ **— done** | The stand-in receives the right `screen` on every path; a hostile screen name renders nothing |
| 3 | ~~**§11 — the glossary**~~ **— done** | Prefix contains it; the changes-versus-commits section is untouched |
| 4 | ~~**§8 — split the briefing**~~ **— done** | Two consecutive first system blocks are byte-identical and carry `cache_control`; `cache_read_input_tokens > 0` on step 2 against the real API |
| 5 | ~~**§7 — the store, persistence, conversations**~~ **— done** | Refresh keeps the conversation; close mid-flight still lands with a badge; caps drop oldest |
| 6 | ~~**§6 — starter and recent questions**~~ **— done** | Chips change with the tab; a persisted question containing `"` and `<` breaks nothing |
| 7 | §9 stage one — real progress steps | Both tool labels appear, in order; an injected search query renders as text |
| 8 | §13 — the three small ones | A `json`-fenced chart draws; no raw JSON is ever visible; the input box is reachable on a phone |
| 9 | §12 — the eval set and effort sweep | ≥95%; the chosen effort tier is recorded with its reason |
| 10 | §9 stage two — stream the words | Text appears as it is written; a dropped stream leaves no message in history |

**Worth shipping on its own: the end of task 5.** At that point the assistant knows where
you are, cannot drift from the tabs, costs meaningfully less to run, and stops forgetting
everything. Streaming and chips are polish on a correct foundation.

---

## 15. Do not do these

1. **Do not size `max_tokens` to the expected answer length.** Thinking shares that
   budget on this model. This is the bug in §4; do not reintroduce it while tuning.
2. **Do not send `temperature`, `top_p`, `top_k` or `budget_tokens`.** All four are
   rejected.
3. **Do not put the live block in a `{ role: 'system' }` message inside `messages`.** Not
   supported on `claude-sonnet-5`; it returns a 400.
4. **Do not interpolate the register, the date, the tab, the commit or any count into the
   cached prefix.** It changes the bytes on every request and silently kills caching.
5. **Do not let the model supply chart data** for any kind except `quoted`. This already
   holds. Keep it holding through the rescue passes in §13.1.
6. **Do not persist an error, or a partial streamed answer, as an assistant turn.** It
   gets re-sent as context on every later question.
7. **Do not splice chip text, recent-question text, or any model-supplied string into an
   inline handler.** `data-` attributes only.
8. **Do not log the briefing, the question, or the answer.** Log ids, token counts,
   latency and `stop_reason`. This repo already gets this right.
9. **Do not skip the drift row when you add a field to a tool.** A new number in the
   assistant's reach without a row is a new way for it to contradict the screen.
10. **Do not replace the changes-versus-commits section with the shorter glossary entry.**
    It is long because the short version was not enough.
11. **Do not hydrate charts from a partially streamed answer.** Render the stream as
    escaped text; run the real render once, on completion.
12. **Do not add a starter question the assistant cannot answer.** A chip that produces
    "I can't see that from here" teaches the owner not to trust the panel.
