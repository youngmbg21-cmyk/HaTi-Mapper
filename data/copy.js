/* HaTi-Mapper — the plain-English phrasebook. HAND-MAINTAINED.
 *
 * "What a person does here" is not something a parser can read out of code.
 * A screen's module path, size, render function and nav position are all
 * derived; the sentence explaining what someone actually does on it is a
 * judgement, the same kind as data/dependencies.js, and inventing one from
 * function names would produce exactly the developer-speak this whole tool
 * exists to avoid.
 *
 * So these sentences are written, and the scan VALIDATES them on every run:
 *
 *   - an entry for a screen or AI feature that no longer exists is reported
 *     as a stale warning
 *   - a screen or AI feature with no entry here renders as "not detected"
 *     rather than silently blank
 *
 * Everything else in every panel is derived from HaTi's source.
 *
 * Keyed by the nav `data-view` id (index.html) and the AI feature name
 * (the aiFeature('...') tag in server/server.js).
 */

export const SCREEN_COPY = {
  dashboard: 'Portfolio dashboard — KPIs, stage breakdown, what needs attention',
  pipeline:  'Kanban board — drag contracts between lifecycle stages',
  advice:    'Legal services pipeline — intake, scoping, delivery, rate card',
  workspace: 'Read, edit, review, comment, share and sign a single contract',
  register:  'Every contract in one table; search, filter, sort, export to CSV',
  calendar:  'Renewals, expiries and notice deadlines by date',
  migration: 'Bulk import of an existing portfolio, with the review queue',
  templates: 'Built-in Kenyan templates, your own uploads, sample contracts',
  playbook:  'Clause library and per-type standards; portfolio deviations',
  reports:   'Portfolio reporting across streams, stages and value',
  intel:     'AI contract graph; ask a question, the map filters and re-clusters',
  team:      'Members, roles, approval gate, reminders, AI keys and caps',
};

/* The menu's own sections, in the owner's words.
 *
 * HaTi's nav wraps its buttons in `<div class="nav-section" data-section="…">`,
 * so which section a screen sits in IS derived — the scan reads it off the
 * markup and puts it on every screen as `group`. What is not derivable is what
 * to CALL each section: the markup carries "work", not "Working on one
 * contract". So the ids are derived and the names are written here, validated
 * on every scan the same way the screen sentences are. A section with no entry
 * shows its raw id rather than being guessed at.
 *
 * `public` is the Mapper's own group, not one of HaTi's: it holds the screens
 * reached by a URL hash instead of by a menu button, which is the same set as
 * "works without logging in".
 */
export const GROUP_COPY = {
  main:   'Seeing the portfolio',
  work:   'Working on one contract',
  advice: 'Advice and reporting',
  admin:  'Admin',
  public: 'The open doors',
};

/* Screens reached by URL hash rather than by a nav entry — no login needed. */
export const HASH_COPY = {
  '#share': {
    label: 'Share portal',
    does: 'Counterparty reviews and signs — no login required',
    public: 'Opens one contract for one recipient. Accepts a single response, then closes.',
  },
  '#advice': {
    label: 'Advice portal',
    does: 'A client submits a legal services request and tracks its progress',
    public: 'Anyone can submit a legal services request and see the rate card and queue load. Quotes are worked out on the server so the browser cannot be trusted with pricing.',
  },
  '#reset': {
    label: 'Password reset',
    does: 'Set a new password from an emailed link',
    public: 'Consumes a single-use, expiring token emailed to a workspace member.',
  },
};

/* What a FILE is, in the owner's words, for the "Getting bulky" panel.
 *
 * Deliberately short. Almost every file already answers this question through
 * data the scan holds: a file that renders a screen borrows that screen's
 * sentence from SCREEN_COPY, a file named in data/dependencies.js borrows the
 * subsystem titles it holds, and the file every route is answered in describes
 * itself by the number of routes found in it. Those are derivations, not
 * judgements, and they stay correct on their own.
 *
 * Only files that no other panel already explains are written here, and the
 * scan validates them the same way it validates the rest: an entry for a file
 * that no longer exists comes back as a stale warning. A file with no entry
 * and nothing derivable says so on screen rather than being guessed at.
 */
export const FILE_COPY = {
  'js/app.js': {
    name: 'The front door',
    does: 'Draws the menu, decides which screen a click opens, and works out what a link like #share means before anyone has logged in.',
  },
  'js/templates.js': {
    name: 'The template shelf',
    does: 'Holds the built-in contract templates and the value streams the rest of the product files contracts under.',
  },
};

/* What each table in HaTi's database HOLDS, in the owner's words.
 *
 * The table's name, its columns and the line it is declared on are all
 * derived — the scan reads them straight out of the CREATE TABLE statements.
 * What a person cannot get from that is what the table is FOR: "contracts"
 * with twelve column names is a schema, not an answer, and this page is not
 * for a developer.
 *
 * Same contract as the rest of this file: the scan validates these on every
 * run, a table with no entry says so on screen rather than being guessed at,
 * and an entry for a table that no longer exists comes back as a warning.
 */
export const TABLE_COPY = {
  contracts:   'One row per contract: who it is with, what stage it is at, what it is worth, and the text itself.',
  versions:    'One row each time a draft was saved, with the seal that proves what the wording was at that moment.',
  shares:      'One row each time a contract was sent out for signature: which contract, to whom, the unguessable code, and whether it has been used.',
  audit:       'The record of who did what and when. This is the evidence behind every signature, not a log you can trim.',
  comments:    'Remarks left on a contract while it was being reviewed.',
  obligations: 'The dates a contract commits you to — payments due, notice deadlines, renewal windows.',
  templates:   'The contract templates you have made, and the fill-in fields defined on each.',
  settings:    'A name-and-value store. Anything HaTi needs to remember that is not a contract ends up here.',
  users:       'One row per person on the workspace, their role, and the scrambled form of their password.',
  sessions:    'One row per signed-in browser, and when that sign-in stops working.',
};

export const FEATURE_COPY = {
  search:      'Ask the register a question',
  graph:       'Filter and re-cluster the map',
  extract:     'Pull out dates, value and parties from a document',
  template:    'Match paper to a contract type',
  playbook:    'Check clauses against your standards',
  obligations: 'Find payment dates and notice deadlines',
  ocr:         'Read text off a scanned page',
  blanks:      'Propose fill-in fields for a template',
  chat:        'Answer questions about the portfolio, citing contracts',
};
