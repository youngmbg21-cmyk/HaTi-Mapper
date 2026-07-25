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
