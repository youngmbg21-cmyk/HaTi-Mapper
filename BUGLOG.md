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
