/* HaTi-Mapper — the "what breaks what" map. HAND-MAINTAINED.
 *
 * This is the one panel that is written rather than derived, and deliberately
 * so. The relationships here are judgements about meaning — "changing this can
 * break something already signed" is not a fact a parser can read out of code,
 * and a parser guessing at it would produce a confident, wrong diagram.
 *
 * The scan does not derive this file, but it does VALIDATE it on every run:
 *
 *   - every `file` named by a subsystem must still exist in HaTi
 *   - every `proof` identifier must still appear somewhere in HaTi's source
 *   - every `field` named by an item must still appear somewhere in HaTi
 *   - every subsystem id an item points at must be defined below
 *
 * Anything that fails comes back as a warning and the panel displays it, so
 * the map degrades visibly instead of quietly lying. When you change HaTi in a
 * way that trips a warning, fix this file — that is the maintenance cost, and
 * it is the price of the panel being about meaning rather than syntax.
 *
 * Seeded from js/versioning.js, js/core.js (sealString, canonicalDoc,
 * freezeContractHtml), js/views/contract.js and js/views/portal.js.
 */

export const DEPENDENCIES = {
  /* The three parts of HaTi a subsystem can belong to. Every subsystem below
     carries a `group`, so the panel reads as an anatomy — the document, the
     proof, and where it shows up — rather than as an alphabet of thirty tiles.
     Which group a subsystem is in is a judgement, like everything else in this
     file; the scan validates that every group named below exists here. */
  groups: [
    { id: 'doc',  title: 'The document itself' },
    { id: 'sign', title: 'Signing, and the proof' },
    { id: 'show', title: 'Where it shows up' },
  ],

  /* The subsystems that read HaTi's data. `file` and `proof` are the anchors
     the scan checks: if either stops existing, this entry is stale. */
  subsystems: [
    { id: 'render', group: 'doc',   title: 'Document viewer',    desc: 'Draws the contract on screen',      file: 'js/views/contract.js',  proof: 'docBodyHtml' },
    { id: 'edit', group: 'doc',     title: 'Editor',             desc: 'Changing the wording',              file: 'js/views/contract.js',  proof: 'openEditDocModal' },
    { id: 'version', group: 'doc',  title: 'Version history',    desc: 'Every saved draft',                 file: 'js/versioning.js',      proof: 'captureVersion' },
    { id: 'compare', group: 'doc',  title: 'Compare',            desc: 'Diff between two versions',         file: 'js/versioning.js',      proof: 'openCompareModal' },
    { id: 'seal', group: 'sign',     title: 'Signature seal',     desc: 'Proof of what was signed',          file: 'js/core.js',            proof: 'sealString' },
    { id: 'ai', group: 'doc',       title: 'AI clause review',   desc: 'Quotes the text back to you',       file: 'js/playbook.js',        proof: 'runPlaybookReview' },
    { id: 'extract', group: 'doc',  title: 'Detail extraction',  desc: 'Dates, value, parties',             file: 'js/metadata.js',        proof: 'extractMetadata' },
    { id: 'portal', group: 'sign',   title: 'Share portal',       desc: 'What the counterparty sees',        file: 'js/views/portal.js',    proof: 'portalEntry' },
    { id: 'pdf', group: 'sign',      title: 'PDF export',         desc: 'And the evidence pack',             file: 'js/views/portal.js',    proof: 'exportPDF' },
    { id: 'register', group: 'show', title: 'Register & filters', desc: 'The main contract table',           file: 'js/views/register.js',  proof: 'renderRegister' },
    { id: 'kpi', group: 'show',      title: 'Home KPIs',          desc: 'Counts and the attention list',     file: 'js/views/home.js',      proof: 'renderDashboard' },
    { id: 'remind', group: 'show',   title: 'Renewal reminders',  desc: '90 / 60 / 30 day emails',           file: 'server/server.js',      proof: 'runReminders' },
    { id: 'cal', group: 'show',      title: 'Calendar',           desc: 'Expiries and deadlines',            file: 'js/views/calendar.js',  proof: 'renderCalendar' },
    { id: 'wizard', group: 'show',   title: 'New contract wizard',desc: 'Starting from a template',          file: 'js/wizard.js',          proof: 'openWizard' },
    { id: 'blanks', group: 'show',   title: 'Add blanks',         desc: 'Fill-in fields on templates',       file: 'js/views/library.js',   proof: 'openBlanksEditor' },
    { id: 'dedupe', group: 'show',   title: 'Duplicate check',    desc: 'Skips files already imported',      file: 'js/dedupe.js',          proof: 'simhash64' },

    /* Added after the first pass: the map was seeded from the mockup and
       stopped at the document. These are the rest of HaTi's moving parts. */
    { id: 'approvals', group: 'sign',title: 'Approval gate',      desc: 'Who must sign off before signing',  file: 'js/approvals.js',       proof: 'buildApprovalChain' },
    { id: 'signers', group: 'sign',  title: 'Signing order',      desc: 'Who signs, and in what order',      file: 'js/approvals.js',       proof: 'signerPlan' },
    { id: 'oblig', group: 'show',    title: 'Obligations',        desc: 'Payment dates, notice deadlines',   file: 'js/obligations.js',     proof: 'renderObligationsSection' },
    { id: 'clauses', group: 'doc',  title: 'Clause library',     desc: 'Your standards for each type',      file: 'js/playbook.js',        proof: 'clauseLibrary' },
    { id: 'copilot', group: 'show',  title: 'The Copilot',        desc: 'The chat assistant inside HaTi',    file: 'js/ai.js',              proof: 'copilotAsk' },
    { id: 'graph', group: 'show',    title: 'Contract graph',     desc: 'The map on the Intel screen',       file: 'js/views/intelligence.js', proof: 'buildGraphModel' },
    { id: 'ocr', group: 'doc',      title: 'Reading scans',      desc: 'Text off a photographed page',      file: 'js/ocr.js',             proof: 'ocrDocument' },
    { id: 'migrate', group: 'show',  title: 'Bulk import',        desc: 'Bringing a back catalogue in',      file: 'js/views/migration.js', proof: 'migProcessFiles' },
    { id: 'reports', group: 'show',  title: 'Reports',            desc: 'Portfolio reporting',               file: 'js/views/reports.js',   proof: 'computeReports' },
    { id: 'queue', group: 'show',    title: 'The queue board',    desc: 'Contracts by lifecycle stage',      file: 'js/views/queue.js',     proof: 'renderPipeline' },
    { id: 'family', group: 'show',   title: 'Amendments',         desc: 'A contract and its amendments',     file: 'js/family.js',          proof: 'effectiveExpiry' },
    { id: 'audit', group: 'sign',    title: 'Audit trail',        desc: 'The record of what happened',       file: 'js/core.js',            proof: 'logAudit' },
    { id: 'sigpad', group: 'sign',   title: 'Signature capture',  desc: 'The drawn or typed mark',           file: 'js/signature.js',       proof: 'openSignaturePad' },
  ],

  /* Each data item: what reads it, and where changing it can break something
     already signed (`risk`). */
  items: [
    {
      key: 'doc',
      label: 'Contract body text',
      fields: ['redlineText', 'versions'],
      reads: ['render', 'edit', 'version', 'compare', 'ai', 'extract', 'portal', 'pdf', 'copilot', 'graph', 'oblig', 'clauses'],
      risk: ['seal'],
      note: '<b>Twelve parts of HaTi read the contract body, and the seal is taken over it.</b> Change how the text is stored and you change what a signed contract hashes to — so anything already signed has to keep verifying. This is why the rich-text change needs its own task before anything is built on top of it.',
    },
    {
      key: 'seal',
      label: 'The signature seal',
      fields: ['sealString', 'freezeContractHtml'],
      reads: ['pdf', 'portal', 'version', 'audit', 'sigpad'],
      risk: ['seal', 'render'],
      note: '<b>The seal is the promise.</b> It fixes the exact wording at the moment of signing, so the signed document must always render from the frozen copy, never from live text. Anything that changes rendering has to be checked against it.',
    },
    {
      key: 'meta',
      label: 'Contract details',
      fields: ['counterparty', 'expiry'],
      reads: ['register', 'kpi', 'remind', 'cal', 'extract', 'pdf', 'reports', 'graph', 'queue', 'family'],
      risk: ['approvals'],
      note: '<b>Ten places read the extracted details.</b> A wrong expiry date matters more than it looks — it flows into the reminders, the calendar, the attention list and the amendment chain, not just the one contract. The value is riskier still: the approval gate keys off it, so changing the value after someone approved leaves a record of an approval that today’s rules would not have granted.',
    },
    {
      key: 'tpl',
      label: 'Template record',
      fields: ['customTemplates'],
      reads: ['wizard', 'blanks', 'edit', 'render', 'migrate'],
      risk: [],
      note: '<b>Templates feed the wizard and the blanks.</b> Editing a template never changes contracts already made from it — those copied the wording at creation. Worth stating on screen, because people assume the opposite.',
    },
    {
      key: 'upload',
      label: 'Uploaded file',
      fields: ['dataUrl', 'fileHash'],
      reads: ['render', 'ai', 'extract', 'dedupe', 'pdf', 'ocr', 'migrate', 'copilot'],
      risk: ['seal'],
      note: '<b>For an uploaded contract, the file itself is the evidence.</b> Its fingerprint is the seal, and the text pulled out of it feeds the AI review and the duplicate check. Bad text extraction quietly poisons all three.',
    },
    {
      key: 'audit',
      label: 'Comments and audit trail',
      fields: ['audit', 'comments'],
      reads: ['render', 'portal', 'pdf', 'reports', 'copilot'],
      risk: ['audit', 'pdf'],
      note: '<b>The audit trail is the evidence, not a log.</b> It is what the evidence pack is built from, so it is the answer to “who did what, and when” long after signing. Rewriting or trimming past entries does not just lose history — it weakens the proof behind every contract already signed.',
    },
    {
      key: 'approval',
      label: 'Approval rules and signing order',
      fields: ['approvalRules', 'signerPlan'],
      reads: ['approvals', 'signers', 'queue', 'kpi'],
      risk: ['approvals'],
      note: '<b>The approval gate decides who must sign off before a contract can be signed.</b> Changing the rules never un-approves anything, but it does leave approvals on record that the current rules would not have produced — so if the threshold moves, the old approvals need reading in the light of the rules that applied at the time.',
    },
    {
      key: 'share',
      label: 'Share links',
      fields: ['shares', 'token'],
      reads: ['portal', 'register', 'audit'],
      risk: ['portal', 'audit'],
      note: '<b>A share link is how a counterparty saw and signed the contract.</b> The link is single-response and expires, and the record of it is part of how a counterparty signature is evidenced. Revoking or reusing tokens after signature muddies that evidence, so old links are better left expired than deleted.',
    },
    {
      key: 'oblig',
      label: 'Obligations',
      fields: ['obligations'],
      reads: ['oblig', 'cal', 'remind', 'kpi', 'reports'],
      risk: [],
      note: '<b>Obligations are the dates that actually cost money if missed</b> — payment terms, notice windows, renewal decisions. They are derived from the contract but stored separately, so a re-extraction can silently replace a set someone has already worked from. Nothing signed breaks, but a missed notice deadline is expensive in a different way.',
    },
    {
      key: 'clause',
      label: 'Clause library and standards',
      fields: ['clauseLibrary', 'playbook'],
      reads: ['clauses', 'ai', 'reports'],
      risk: [],
      note: '<b>Your standards are what the AI review measures a contract against.</b> Editing them changes what future reviews flag, and re-running a review on an old contract will give a different answer than it did before. Nothing already signed changes — but a deviation report from last quarter is not comparable with one from today.',
    },
  ],
};
