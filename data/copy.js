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
  dashboard: 'Home — the portfolio at a glance: what needs attention, what is due, what moved',
  register:  'Contracts — every contract in one table; open one for its document, negotiation and signing',
  calendar:  'Renewals, expiries and notice deadlines by date',
  intel:     'Insights — how the portfolio is behaving, with the contract graph you can ask questions of',
  templates: 'The paper you draft from: your company standards, counterparty paper, and HaTi’s own',
  team:      'Members, roles, the approval gate, reminders, and the AI keys and caps',
  playbook:  'Our standards — the clause library and negotiation playbook every review checks against',
  advice:    'Advice Desk — client requests come in here, get scoped, and get delivered',
  migration: 'Import contracts — a whole back-catalogue at once, extracted by Copilot and reviewed by a person',
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
  work:     'The day-to-day work',
  settings: 'Standards, people and setup',
  public:   'The open doors',
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
  /* The contracts themselves, and everything hanging off one. */
  contracts:               'One row per contract: who it is with, what stage it is at, what it is worth, when it expires, and the document itself.',
  files:                   'The uploaded documents, held whole — the PDFs and Word files people drop in, kept as they arrived.',
  templates:               'The paper you draft from: your own templates and the ones HaTi ships, with what each is for.',
  template_versions:       'Each published draft of a template, so a template can change without changing the contracts already made from it.',
  template_blocks:         'A template broken into its parts, in order — the clauses and paragraphs a draft is assembled from.',
  template_fields:         'The fill-in fields on a template: what to ask for, what kind of answer it takes, and whether a person has checked it.',

  /* Sending a contract out, and everything that comes back. */
  shares:                  'One row each time a contract was sent out for signature — the unguessable link, and what came back on it.',
  share_responses:         'What a counterparty sent back on a share link, and whether it has been applied to the contract yet.',
  share_payload_history:   'What the counterparty was actually shown, each time, and when they opened it. This is the record of what they saw.',
  share_messages:          'The back-and-forth with a counterparty on a share link, kept by topic.',
  share_otp:               'The one-time codes emailed to a counterparty to prove they are who the link was sent to.',
  engagement:              'Who opened a shared contract and when — the trail behind "have they looked at it yet?".',
  activation:              'The milestones a contract passed and when it first passed each one.',

  /* People, and getting into the workspace. */
  users:                   'One row per person on the workspace, their role, and the scrambled form of their password.',
  sessions:                'One row per signed-in browser, so signing out somewhere can end that sign-in and no other.',
  resets:                  'The single-use, expiring links emailed out when someone has forgotten their password.',

  /* Work coming in, and work going out. */
  advice_requests:         'Requests that came in through the Advice Desk: what was asked for, who asked, and where it has got to.',
  batches:                 'One row per bulk import: when it ran, who started it, and what happened to each row in it.',
  outbox:                  'Every email HaTi has tried to send, whether it went, and who carried it.',
  reminders:               'A note that a particular reminder has already gone out, so nobody is emailed the same thing twice.',

  /* What the AI did, and what it cost. */
  copilot_log:             'Every question put to the Copilot and the answer it gave, with the contracts it cited.',
  ai_spend:                'The running total of what the AI has cost, by day and by feature. This is the real bill, not an estimate.',

  /* Settings, and the odds and ends. */
  settings:                'A name-and-value store. Anything HaTi needs to remember that is not a contract ends up here.',
  store:                   'A second name-and-value store, for the things the front end keeps between visits.',
  org_branding:            'Your company’s name, logo, registration number and footer — what appears on the paper you send out.',
  org_profile_values:      'The details about your company that get filled into a template automatically.',
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
  template_convert: 'Turn an uploaded document into a template you can draft from',
};
