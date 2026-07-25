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
  /* The subsystems that read HaTi's data. `file` and `proof` are the anchors
     the scan checks: if either stops existing, this entry is stale. */
  subsystems: [
    { id: 'render',   title: 'Document viewer',    desc: 'Draws the contract on screen',      file: 'js/views/contract.js',  proof: 'docBodyHtml' },
    { id: 'edit',     title: 'Editor',             desc: 'Changing the wording',              file: 'js/views/contract.js',  proof: 'openEditDocModal' },
    { id: 'version',  title: 'Version history',    desc: 'Every saved draft',                 file: 'js/versioning.js',      proof: 'captureVersion' },
    { id: 'compare',  title: 'Compare',            desc: 'Diff between two versions',         file: 'js/versioning.js',      proof: 'openCompareModal' },
    { id: 'seal',     title: 'Signature seal',     desc: 'Proof of what was signed',          file: 'js/core.js',            proof: 'sealString' },
    { id: 'ai',       title: 'AI clause review',   desc: 'Quotes the text back to you',       file: 'js/playbook.js',        proof: 'runPlaybookReview' },
    { id: 'extract',  title: 'Detail extraction',  desc: 'Dates, value, parties',             file: 'js/metadata.js',        proof: 'extractMetadata' },
    { id: 'portal',   title: 'Share portal',       desc: 'What the counterparty sees',        file: 'js/views/portal.js',    proof: 'portalEntry' },
    { id: 'pdf',      title: 'PDF export',         desc: 'And the evidence pack',             file: 'js/views/portal.js',    proof: 'exportPDF' },
    { id: 'register', title: 'Register & filters', desc: 'The main contract table',           file: 'js/views/register.js',  proof: 'renderRegister' },
    { id: 'kpi',      title: 'Home KPIs',          desc: 'Counts and the attention list',     file: 'js/views/home.js',      proof: 'renderDashboard' },
    { id: 'remind',   title: 'Renewal reminders',  desc: '90 / 60 / 30 day emails',           file: 'server/server.js',      proof: 'runReminders' },
    { id: 'cal',      title: 'Calendar',           desc: 'Expiries and deadlines',            file: 'js/views/calendar.js',  proof: 'renderCalendar' },
    { id: 'wizard',   title: 'New contract wizard',desc: 'Starting from a template',          file: 'js/wizard.js',          proof: 'openWizard' },
    { id: 'blanks',   title: 'Add blanks',         desc: 'Fill-in fields on templates',       file: 'js/views/library.js',   proof: 'openBlanksEditor' },
    { id: 'dedupe',   title: 'Duplicate check',    desc: 'Skips files already imported',      file: 'js/dedupe.js',          proof: 'simhash64' },
  ],

  /* Each data item: what reads it, and where changing it can break something
     already signed (`risk`). */
  items: [
    {
      key: 'doc',
      label: 'Contract body text',
      fields: ['redlineText', 'versions'],
      reads: ['render', 'edit', 'version', 'compare', 'ai', 'extract', 'portal', 'pdf'],
      risk: ['seal'],
      note: '<b>Eight parts of HaTi read the contract body, and the seal is taken over it.</b> Change how the text is stored and you change what a signed contract hashes to — so anything already signed has to keep verifying. This is why the rich-text change needs its own task before anything is built on top of it.',
    },
    {
      key: 'seal',
      label: 'The signature seal',
      fields: ['sealString', 'freezeContractHtml'],
      reads: ['pdf', 'portal', 'version'],
      risk: ['seal', 'render'],
      note: '<b>The seal is the promise.</b> It fixes the exact wording at the moment of signing, so the signed document must always render from the frozen copy, never from live text. Anything that changes rendering has to be checked against it.',
    },
    {
      key: 'meta',
      label: 'Contract details',
      fields: ['counterparty', 'expiry'],
      reads: ['register', 'kpi', 'remind', 'cal', 'extract', 'pdf'],
      risk: [],
      note: '<b>Six places read the extracted details.</b> This is why a wrong expiry date matters more than it looks — it flows into the reminders, the calendar and the attention list, not just the one contract.',
    },
    {
      key: 'tpl',
      label: 'Template record',
      fields: ['customTemplates'],
      reads: ['wizard', 'blanks', 'edit', 'render'],
      risk: [],
      note: '<b>Templates feed the wizard and the blanks.</b> Editing a template never changes contracts already made from it — those copied the wording at creation. Worth stating on screen, because people assume the opposite.',
    },
    {
      key: 'upload',
      label: 'Uploaded file',
      fields: ['dataUrl', 'fileHash'],
      reads: ['render', 'ai', 'extract', 'dedupe', 'pdf'],
      risk: ['seal'],
      note: '<b>For an uploaded contract, the file itself is the evidence.</b> Its fingerprint is the seal, and the text pulled out of it feeds the AI review and the duplicate check. Bad text extraction quietly poisons all three.',
    },
  ],
};
