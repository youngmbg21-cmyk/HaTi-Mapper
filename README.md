# HaTi-Mapper

An internal diagnostic dashboard for [HaTi](https://github.com/youngmbg21-cmyk/mkataba-clm),
the contract lifecycle platform. Eight panels answering eight questions about
the product, written for someone who does not read code:

| Panel | Answers |
|---|---|
| **Screens** | Every screen in the product, what a person does there, and the file it lives in |
| **Where the money goes** | Every feature that calls Anthropic, which model, which cap, and which screens use it |
| **Where things are kept** | Every database table and what is inside it |
| **What breaks what** | Pick a piece of data, see everything that depends on it — and what changing it can break that is already signed |
| **Not finished** | Known gaps, gathered from the code and the written documents |
| **Open to the public** | Everything that works without logging in |
| **What changed** | Recent commits in plain language, grouped by area |
| **Getting bulky** | File sizes, and the names published on `window` that nothing references |

Seven of the eight panels are read from HaTi's **source code**. Only "Where the
money goes" needs anything from a running HaTi, and all it asks for is caps and
a count.

---

## Security

The Mapper is a new door into information about HaTi, so three rules shape it:

**1. Numbers only, never content.** The one endpoint that touches a running
HaTi returns caps, a request count, a boolean, a mode and a commit hash. No
contract text, counterparty, party email, monetary value, file name, user
name, session token, share token or API key can cross it — where the dashboard
shows that a key is configured, HaTi returns a boolean, never the key.

**2. HaTi's endpoint is off by default, one direction, read-only.** It exists
only when `MAPPER_TOKEN` is set in HaTi's environment; unset, the route returns
404 as though it were never built. It requires that token as a bearer
credential, is `GET` only, is rate limited, and sends no CORS headers — the
Mapper calls it server-to-server, and their absence stops any browser reaching
it directly. The Mapper never writes to HaTi.

**3. The Mapper itself is not public.** It displays HaTi's file paths, its
unauthenticated routes and its known weaknesses. Keep the URL private, and both
data routes require `MAPPER_ACCESS_TOKEN`: the browser asks for it once, holds
it in `sessionStorage`, and sends it on every call. Without it there is no
data, and the failure is worded identically whether the token was wrong or the
backend was down.

Every secret lives in an environment variable read by the server. **No token,
key or repository credential appears in `index.html`, in `app.js`, or in any
other file served to the browser** — the server serves exactly two files and
refuses everything else.

---

## Environment variables

Set all four in the Render dashboard. None belongs in git.

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | A **fine-grained** personal access token with **read-only Contents** permission on `youngmbg21-cmyk/mkataba-clm` **and nothing else**. Without it GitHub allows 60 requests an hour, which a handful of scans exhausts; with it, 5,000. |
| `HATI_URL` | Base URL of the running HaTi, e.g. `https://hati-clm.onrender.com`. Unset → the spend panel shows code defaults and says so; the other seven panels are unaffected. |
| `MAPPER_TOKEN` | Must match the `MAPPER_TOKEN` set on **HaTi**. This is the bearer credential the Mapper presents to HaTi's `/api/pulse`. |
| `MAPPER_ACCESS_TOKEN` | What the browser must present to load anything. Use a long random value. **If this is unset the Mapper refuses every data request** — an unset variable never means "open". |

Optional: `HATI_REPO` (default `youngmbg21-cmyk/mkataba-clm`), `HATI_REF`
(default `main`), `COMMIT_COUNT` (default `20`), `PORT` (default `3000`).

---

## Deploying

`render.yaml` at the repository root defines one Node web service — no build
command, `npm start`, health check on `/api/health`, mirroring HaTi's own
blueprint. On render.com choose **New + → Blueprint**, connect this repo, then
set the four variables above in the dashboard.

Then, on **HaTi's** service, set `MAPPER_TOKEN` to the same value and redeploy.
Until you do, the spend panel degrades gracefully and everything else works.

**One Render caveat.** On the free tier a service spins down after inactivity
and takes the better part of a minute to wake. The ten-minute scan cache lives
in memory and dies with it, so the first load after an idle period is slow. The
front end says what it is doing and roughly how long it will take rather than
appearing to hang.

## Running locally

```
npm install
MAPPER_ACCESS_TOKEN=anything GITHUB_TOKEN=ghp_... npm start
```

Then open http://localhost:3000. `npm run verify` drives the whole thing
headlessly and asserts the checks in `test/verify.mjs`.

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
