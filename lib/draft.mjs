/* HaTi-Mapper — turning a finding into a prompt you can paste.
 *
 * The dashboard is good at showing the owner what is wrong and useless at
 * helping them do anything about it: the next step is always "describe this
 * accurately to an overnight Claude Code session", and describing it
 * accurately means naming files and identifiers they cannot be expected to
 * remember. That gap is where the tool stops being useful.
 *
 * So the finding is turned into an instruction here, on the server, from the
 * scan payload — the paths and names are copied out of what was actually
 * scanned rather than typed by anyone, which is the whole point. The model
 * then writes the prompt; it does not invent the facts.
 *
 * Nothing here calls anything. It builds a string, which the existing chat
 * loop sends through the existing key, budget and rate limit.
 */

/* The owner's standing rules for any session on HaTi. These go into every
   drafted prompt VERBATIM — they are the things that have gone wrong before,
   and a prompt that omits them is worse than no prompt. */
export const BOUNDARIES = [
  'Do not build or modify the mobile/WhatsApp counterparty portal.',
  'Do not change anything outside the scope described above. No "while I am here" refactors.',
  'Add no new runtime dependencies.',
  "Run the project's verification before finishing, and do not finish while it is failing.",
  'Produce BUGLOG.md and SUMMARY.md updates describing what changed and anything that did not work.',
  'Update the README in the same commit as any change that alters behaviour.',
  'Write all user-facing text in plain English, for someone who does not read code.',
];

const kb = b => Math.round(b / 1024) + ' KB';

/* Find the thing the owner clicked on, and say what is known about it — only
   from the scan. An id that matches nothing is an error, not an empty prompt:
   drafting a prompt about a finding that no longer exists would be exactly the
   confident wrong answer this tool exists to avoid. */
export function describeFinding(scan, kind, id, extra) {
  const s = scan || {};
  const ctx = extra || {};

  /* A door that answered differently from what its own code promises. The
     facts come from two places — the scan for what the code says, the last
     live knock for what actually happened — and both are named, because the
     whole point of this finding is that they disagree. */
  if (kind === 'door') {
    const address = String(id || '');
    const route = (s.public?.routes || []).find(r => `${r.method} ${r.path}` === address);
    const knock = (ctx.doors?.results || []).find(r => r.address === address);
    if (!route && !knock) return { error: `There is no open address called "${address}" in the latest scan.` };
    if (knock && knock.verdict === 'as-expected') {
      return { error: `${address} answered exactly as its code says it should, so there is nothing to report.` };
    }
    const guards = [];
    if (route?.servesShell) guards.push('it serves the app shell and no data');
    if (route?.tokenGuarded) guards.push('its handler checks its own secret');
    if (route?.tokenInPath) guards.push('it needs an unguessable code in the URL');
    if (route?.middleware?.length) guards.push(`it is rate limited by ${route.middleware.join(', ')}`);
    return {
      title: `An address that behaved differently from what its code promises: ${address}`,
      facts: [
        `${address} is declared in server/server.js${route ? ':' + route.line : ''} with no auth middleware in its chain.`,
        guards.length
          ? `What the code says guards it: ${guards.join('; ')}.`
          : 'Nothing in the handler checks who is asking — no login, no token, no other guard the scan could find.',
        knock ? `When the Mapper knocked on the live site, it ${knock.says}` : null,
        knock ? `The code led us to expect it ${knock.expected}.` : 'The live site has not been knocked on, so this is the code\'s claim alone.',
        `${(s.public?.routes || []).length} of HaTi's ${s.public?.totalRoutes} server routes carry no login check.`,
      ].filter(Boolean),
      ask: 'Work out whether this address is meant to answer without a login. If it is not, put a guard in front of it. ' +
        'If it is, say plainly why that is safe and write the reason into SECURITY.md so the next person does not have to work it out again.',
    };
  }

  if (kind === 'ai-unused') {
    const f = (s.ai?.features || []).find(x => x.feature === id || x.route === id);
    if (!f) return { error: `There is no AI feature called "${id}" in the latest scan.` };
    if ((f.usedBy || []).length) return { error: `${f.label || f.feature} is called from the app, so there is nothing to report.` };
    const price = (s.cost?.features || []).find(c => c.feature === f.feature);
    return {
      title: `A paid AI endpoint nothing calls: ${f.label || f.feature}`,
      facts: [
        `The endpoint is ${f.route}, tagged aiFeature('${f.feature}') in server/server.js.`,
        `It calls Anthropic on the ${(f.tiers || []).join(' or ') || 'unknown'} tier, model ${(f.models || []).join(' / ') || 'not detected'}.`,
        f.maxTokens ? `Its handler caps one answer at ${f.maxTokens} tokens.` : null,
        price && price.perRequestUsd != null ? `At list prices that is roughly ${price.perRequestUsd.toFixed(4)} US dollars per call at the cap.` : null,
        `Nothing in js/ calls api('ai/${f.feature}') — the Mapper scanned every source file and found no call site.`,
        `It is rate limited by ${f.limiter || 'no limiter the scan could find'}.`,
      ].filter(Boolean),
      ask: 'Decide whether to wire it up or remove it, and do whichever is right. An AI endpoint nobody calls is still a door that costs money if anything finds it.',
    };
  }

  if (kind === 'orphan') {
    const o = (s.weight?.orphans || []).find(x => x.name === id);
    if (!o) return { error: `No unused published name called "${id}" in the latest scan.` };
    return {
      title: `A name published on window that nothing references: ${o.name}`,
      facts: [
        `${o.name} is attached to window by ${o.exportedFrom}, inside an Object.assign(window, { … }) block.`,
        `Across every scanned source file it appears ${o.uses} time${o.uses === 1 ? '' : 's'} outside those export blocks — that is its own declaration and nothing else.`,
        `${(s.weight?.orphans || []).length} of ${s.weight?.exportCount} published names are in the same position.`,
      ],
      ask: `Work out whether ${o.name} is genuinely dead or is reached in a way the scan cannot see (a string lookup, an inline handler in index.html, a dynamic call). If it is dead, remove it and its export. If it is not, leave it and say how it is reached.`,
    };
  }

  /* Every unused published name at once. One prompt per name was thirty
     prompts for one decision, and the decision is the same each time: work out
     whether the scan is right that nothing reaches it. */
  if (kind === 'orphan-all') {
    const all = s.weight?.orphans || [];
    if (!all.length) return { error: 'Every published name is used somewhere, so there is nothing to report.' };
    const byFile = new Map();
    for (const o of all) {
      if (!byFile.has(o.exportedFrom)) byFile.set(o.exportedFrom, []);
      byFile.get(o.exportedFrom).push(o.name);
    }
    return {
      title: `${all.length} names published on window that nothing references`,
      facts: [
        `${all.length} of HaTi's ${s.weight?.exportCount} published names appear exactly once across every scanned source file — their own declaration — and nowhere else.`,
        ...[...byFile.entries()].map(([file, names]) => `${file} publishes ${names.length} of them: ${names.join(', ')}.`),
        'The scan reads whole-word occurrences outside the Object.assign(window, { … }) export blocks, so a name reached by a string lookup, an inline handler in index.html or a dynamic call would not be seen.',
      ],
      ask: 'For each name, work out whether it is genuinely dead or is reached in a way the scan cannot see. Remove the ones that are dead, together with their export. Leave the ones that are not, and say for each how it is reached.',
    };
  }

  if (kind === 'file-size') {
    const f = (s.weight?.files || []).find(x => x.path === id);
    if (!f) return { error: `No file called "${id}" in the latest scan.` };
    const facts = (s.moduleFacts || []).find(m => m.module === f.path);
    const screens = (s.screens || []).filter(x => x.module === f.path).map(x => x.label);
    return {
      title: `A file that has grown hard to work on: ${f.path}`,
      facts: [
        `${f.path} is ${kb(f.bytes)}, against a comfortable line of ${kb(s.weight?.threshold || 61440)}.`,
        facts && facts.sections?.length ? `Its own section banners say it holds ${facts.sections.length} separate jobs: ${facts.sections.join('; ')}.` : null,
        facts ? `It publishes ${facts.exportCount} names on window.` : null,
        screens.length ? `It renders ${screens.length} screen${screens.length === 1 ? '' : 's'}: ${screens.join(', ')}.` : null,
        `${s.weight?.overThreshold} file${s.weight?.overThreshold === 1 ? ' is' : 's are'} over the line in total.`,
      ].filter(Boolean),
      ask: 'Split it along the seams its own section banners already mark, keeping every published name reachable exactly as it is now. Behaviour must not change — this is a move, not a rewrite.',
    };
  }

  if (kind === 'gap') {
    const g = (s.gaps?.gaps || []).find(x => x.title === id);
    if (!g) return { error: `No gap called "${id}" in the latest scan.` };
    return {
      title: `Something the documents admit is not finished: ${g.title}`,
      facts: [
        `Written down in ${g.source}.`,
        g.detail ? `In full: ${g.detail}` : null,
        g.severity ? `The document states its severity as ${g.severity}.` : 'The document states no severity for it.',
        g.marker ? `It is a ${g.marker} marker left in the code.` : null,
      ].filter(Boolean),
      ask: 'Close this gap, and remove the line that records it from the document it is written in — the document and the code have to agree afterwards.',
    };
  }

  if (kind === 'tripped') {
    const t = (s.tripped || []).find(x => x.key === id);
    if (!t) return { error: 'That alert is no longer showing.' };
    return {
      title: t.title,
      facts: [
        t.text,
        `Noticed by the Mapper at ${t.at}.`,
        (s.public?.routes || []).length ? `For context, ${s.public.routes.length} of HaTi's ${s.public.totalRoutes} server routes carry no login check.` : null,
      ].filter(Boolean),
      ask: 'Work out whether this was deliberate. If it was not, put it back. If it was, say plainly why it is safe and write that reason into SECURITY.md so the next person does not have to work it out again.',
    };
  }

  return { error: `There is no kind of finding called "${kind}".` };
}

/* The message the model is asked to turn into a prompt. Everything factual in
   here came out of the scan; the model's job is wording, not research.

   This enumerates a fixed structure — "the prompt you write must do these
   three things" — and an enumeration that specific, sitting right next to the
   question, beats a general style rule in the background briefing every time.
   So the enumeration itself carries the register rather than ignoring it. What
   the register changes here is narrow and deliberate: the drafted prompt is
   read by a coding agent, so its file paths and identifiers stay exact in both
   registers. What moves is whether the prompt also explains itself to the
   owner reading it over that agent's shoulder. */
export function draftInstruction(scan, finding, register) {
  const repo = scan?.repo || 'the HaTi repository';
  const technical = String(register || '').toLowerCase() === 'technical';
  const shaping = technical
    ? [
      '- open by stating the finding, with the exact file paths and identifiers above',
      '- scope the change narrowly, and say what is out of scope',
      '- name the verification the session must run, and any file it must update',
      '- end with this list of standing rules, reproduced word for word:',
    ]
    : [
      '- open with one sentence, in ordinary English, saying what is wrong and why it matters — the owner reads this prompt before pasting it',
      '- then state the finding, with the exact file paths and identifiers above; those stay exact, they are for the session, not for the owner',
      '- scope the change narrowly, and say what is out of scope',
      '- end with this list of standing rules, reproduced word for word:',
    ];
  return [
    'Write a Claude Code prompt that I can paste, unchanged, into an unattended session on ' + repo + '.',
    '',
    'THE FINDING — these facts came from a scan of the repository, so use them as given and do not restate them as uncertain:',
    finding.title,
    ...finding.facts.map(f => '- ' + f),
    '',
    'WHAT THE SESSION SHOULD DO',
    finding.ask,
    '',
    'THE PROMPT YOU WRITE MUST',
    ...shaping,
    ...BOUNDARIES.map(b => '  ' + b),
    '',
    'Reply with the prompt itself and nothing else — no preamble, no explanation of what you wrote, no surrounding quotes. It is going to be pasted directly.',
  ].join('\n');
}

/* What the system prompt gains while drafting. The assistant is otherwise
   built to explain things to someone who does not read code; a fix prompt is
   the one thing it produces for a machine instead.

   A function, not a constant, for the same reason everything register-shaped
   here is a function: a constant assembled when the module loads freezes
   whichever register happened to be current at boot. */
export function draftSystem(register) {
  const technical = String(register || '').toLowerCase() === 'technical';
  return `
YOU ARE DRAFTING A PROMPT, NOT ANSWERING A QUESTION
This turn is different from every other. The owner has pressed "Draft a fix prompt" on a finding. You are writing the text of a prompt that will be pasted into a separate Claude Code session working on HaTi's own repository — not the Mapper's.

- Write for that session, not for the owner. It reads code; precision beats plain English here, and this is the only place that is true.
- Every file path, identifier, route and number you use must come from the finding you were given. Do not add facts. If something matters and you were not told it, tell the session to check it rather than asserting it.
- Reproduce the standing rules exactly as given, word for word, as the last part of the prompt. They are the owner's, not yours to improve.
- No chart. A prompt that is going to be pasted somewhere else cannot carry one.
- Deliver it with deliver_answer, with the whole prompt as the answer and nothing else in it. No preamble, no commentary, no quote marks around it.
${technical
  ? '- REGISTER: TECHNICAL. Write the whole prompt for the session. Precision throughout; no explanation of terms, no framing for the owner.'
  : '- REGISTER: PLAIN. The owner reads this prompt before pasting it, so open with one sentence in ordinary English saying what is wrong and why it matters. Everything after that sentence is for the session and stays exact — plain English never means a vaguer file path.'}`;
}
