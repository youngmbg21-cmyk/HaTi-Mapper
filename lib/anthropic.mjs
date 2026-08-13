/* HaTi-Mapper — the Anthropic call.
 *
 * Same shape as HaTi's own anthropicMessages: one POST to the Messages API,
 * the key passed as a header and never logged, and a single retry on the tier
 * default if a configured model id is rejected. Kept deliberately small — the
 * Mapper makes one kind of call (a chat turn with tools), not five.
 */

/* Points at Anthropic. ANTHROPIC_BASE_URL exists so the tool loop can be
   exercised against a stand-in during testing, and so the call can be pointed
   at a gateway if one is ever put in front of it. Left unset in normal use. */
const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const API = `${BASE}/v1/messages`;
const VERSION = '2023-06-01';

/* The Mapper's chat explains a codebase to someone who does not read code, so
   it defaults to a stronger model than HaTi's Copilot: the volume is one
   person asking occasional questions, and the quality of the explanation is
   the whole point. Override with ANTHROPIC_MODEL. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

const looksLikeModelRejection = (status, body) =>
  (status === 400 || status === 404) && /model/i.test(String(body || ''));

export async function messages(key, payload, model) {
  const chosen = (model || '').trim() || DEFAULT_MODEL;

  const send = (m) => fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, model: m }),
  });

  let r;
  try {
    r = await send(chosen);
  } catch (e) {
    return { ok: false, status: 0, error: `Could not reach Anthropic: ${e.message}`, model: chosen };
  }

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    if (chosen !== DEFAULT_MODEL && looksLikeModelRejection(r.status, text)) {
      console.warn(`[chat] model "${chosen}" rejected (HTTP ${r.status}); retrying once with "${DEFAULT_MODEL}".`);
      const r2 = await send(DEFAULT_MODEL);
      if (!r2.ok) return { ok: false, status: r2.status, error: await r2.text().catch(() => ''), model: DEFAULT_MODEL };
      return { ok: true, data: await r2.json(), model: DEFAULT_MODEL, fellBack: true, rejectedModel: chosen };
    }
    return { ok: false, status: r.status, error: text, model: chosen };
  }

  return { ok: true, data: await r.json(), model: chosen };
}

/* ------------------------------------------------------------- streaming
 *
 * The same one call, read as it arrives instead of all at once.
 *
 * The answer does not come back as ordinary text. It comes back as the
 * `answer` field inside the model's call to deliver_answer, so on the wire it
 * is a JSON string being built a fragment at a time. Recovering the readable
 * part of a half-written JSON string is what partialAnswer() below does, and
 * it is why `eager_input_streaming` is set on that one tool: without it the
 * input arrives whole, at the end, which is the thing being fixed.
 *
 * The preview is a preview. Whatever it produces is thrown away and the
 * committed message is rendered from the assembled input, so a fragment that
 * decodes oddly costs a flicker and never a wrong answer.
 */

/* The readable prefix of the `answer` field in a partly-arrived JSON object.
   Returns '' until the field starts. Stops at an escape that is split across
   chunks rather than guessing at it — the next fragment completes it. */
export function partialAnswer(partial) {
  const s = String(partial || '');
  const at = s.indexOf('"answer"');
  if (at < 0) return '';
  const open = s.indexOf('"', at + 8);
  if (open < 0) return '';
  let out = '';
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) break;                       // split escape; wait
      if (n === 'u') {
        if (i + 5 >= s.length) break;                   // split \uXXXX; wait
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 5;
      } else {
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[n] || n;
        i += 1;
      }
      continue;
    }
    if (c === '"') break;                               // the field ended
    out += c;
  }
  return out;
}

/* Rebuild the whole message from its events, in the shape messages() returns,
   so nothing downstream has to know which of the two it was given. */
function assembler() {
  const msg = { id: null, type: 'message', role: 'assistant', model: null,
    content: [], stop_reason: null, stop_details: null, usage: {} };
  const partials = new Map();      // block index -> the JSON arriving for it

  return {
    msg,
    event(ev) {
      if (!ev || !ev.type) return null;
      if (ev.type === 'message_start' && ev.message) {
        Object.assign(msg, ev.message, { content: [] });
        return null;
      }
      if (ev.type === 'content_block_start') {
        msg.content[ev.index] = { ...ev.content_block };
        if (msg.content[ev.index].type === 'text' && msg.content[ev.index].text == null) {
          msg.content[ev.index].text = '';
        }
        partials.set(ev.index, '');
        return null;
      }
      if (ev.type === 'content_block_delta') {
        const b = msg.content[ev.index];
        if (!b) return null;
        const d = ev.delta || {};
        if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; return null; }
        if (d.type === 'thinking_delta') { b.thinking = (b.thinking || '') + d.thinking; return null; }
        if (d.type === 'input_json_delta') {
          partials.set(ev.index, (partials.get(ev.index) || '') + (d.partial_json || ''));
          /* Only deliver_answer is worth previewing — it is the only block
             whose input the reader is going to be shown. */
          if (b.name === 'deliver_answer') return { answer: partialAnswer(partials.get(ev.index)) };
          return null;
        }
        return null;
      }
      if (ev.type === 'content_block_stop') {
        const b = msg.content[ev.index];
        const raw = partials.get(ev.index);
        if (b && raw) { try { b.input = JSON.parse(raw); } catch (_) { b.input = b.input || {}; } }
        return null;
      }
      if (ev.type === 'message_delta') {
        if (ev.delta) Object.assign(msg, ev.delta);
        if (ev.usage) msg.usage = { ...msg.usage, ...ev.usage };
        return null;
      }
      return null;
    },
    finish() {
      msg.content = msg.content.filter(Boolean);
      return msg;
    },
  };
}

/* One streamed turn. `onAnswer(text)` is called with the whole readable answer
   so far, as often as it grows; the caller sends the difference.
 *
 * A far end that answers with ordinary JSON rather than a stream is read as
 * ordinary JSON. That is not only for the stand-in the tests use: a proxy that
 * buffers produces exactly the same thing, and an assistant that fell over
 * because something in the middle would not stream would be a poor trade for a
 * word-by-word preview. */
/* The parts of a request that make the answer nicer and none of which make it
 * CORRECT: how hard to think, whether the rulebook is cached, and whether the
 * answer streams a fragment at a time or arrives whole.
 *
 * Every one of them is a documented, generally-available field. Every one of
 * them is also a field that a particular model, account or gateway in the
 * middle can decline — and when that happens the whole request is refused with
 * a 400 and the owner gets no answer at all, which is a wretched trade for a
 * setting whose entire job was to be an improvement.
 *
 * So a 400 is treated as "one of these was not welcome here": the request is
 * sent again without them, and what is lost is a little cost control and a
 * word-by-word preview rather than the assistant. What was dropped, and what
 * the provider actually said, goes in the log — the message describes the
 * SHAPE of the request and carries none of the owner's data. */
function withoutExtras(payload) {
  const bare = { ...payload };
  delete bare.output_config;
  if (Array.isArray(bare.system)) {
    bare.system = bare.system.map(({ cache_control, ...rest }) => rest);
  }
  if (Array.isArray(bare.tools)) {
    bare.tools = bare.tools.map(({ eager_input_streaming, ...rest }) => rest);
  }
  return bare;
}

export async function streamMessages(key, payload, model, onAnswer) {
  const chosen = (model || '').trim() || DEFAULT_MODEL;

  const send = (m, p) => fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ ...p, model: m, stream: true }),
  });

  let r;
  try {
    r = await send(chosen, payload);
  } catch (e) {
    return { ok: false, status: 0, error: `Could not reach Anthropic: ${e.message}`, model: chosen };
  }

  if (!r.ok) {
    const text = await r.text().catch(() => '');

    if (chosen !== DEFAULT_MODEL && looksLikeModelRejection(r.status, text)) {
      console.warn(`[chat] model "${chosen}" rejected (HTTP ${r.status}); retrying once with "${DEFAULT_MODEL}".`);
      const r2 = await send(DEFAULT_MODEL, payload);
      if (!r2.ok) return { ok: false, status: r2.status, error: await r2.text().catch(() => ''), model: DEFAULT_MODEL };
      return readStream(r2, DEFAULT_MODEL, onAnswer, { fellBack: true, rejectedModel: chosen });
    }

    /* A 400 is the request being refused on its shape rather than on its
       content, so the one thing worth trying is the same question asked more
       plainly. */
    if (r.status === 400) {
      console.warn('[chat] the request was refused on its shape; retrying without effort, ' +
        'prompt caching and eager streaming. Anthropic said: ' + String(text).slice(0, 500));
      let r3 = null;
      try { r3 = await send(chosen, withoutExtras(payload)); } catch (_) { r3 = null; }
      if (r3 && r3.ok) {
        console.warn('[chat] that worked, so one of those three is not accepted here. ' +
          'Answers are unaffected; the cost saving and the live preview are.');
        return readStream(r3, chosen, onAnswer, { droppedExtras: true });
      }
      const also = r3 ? await r3.text().catch(() => '') : '';
      if (also) console.warn('[chat] and without them too: ' + String(also).slice(0, 500));
      return { ok: false, status: r.status, error: text, model: chosen };
    }

    return { ok: false, status: r.status, error: text, model: chosen };
  }

  return readStream(r, chosen, onAnswer);
}

async function readStream(r, model, onAnswer, extra) {
  const kind = String(r.headers.get('content-type') || '');
  if (!/text\/event-stream/i.test(kind) || !r.body) {
    /* Not a stream. Read it as the whole answer it evidently is. */
    const text = await r.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch (_) {
      return { ok: false, status: r.status, error: `Anthropic sent something unreadable: ${text.slice(0, 200)}`, model };
    }
    return { ok: true, data, model, streamed: false, ...(extra || {}) };
  }

  const asm = assembler();
  let sent = '';
  let buf = '';
  const decoder = new TextDecoder();

  const consume = (chunk) => {
    buf += chunk;
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const block of parts) {
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data || data === '[DONE]') continue;
      let ev = null;
      try { ev = JSON.parse(data); } catch (_) { continue; }
      const preview = asm.event(ev);
      if (preview && onAnswer && preview.answer.length > sent.length) {
        onAnswer(preview.answer.slice(sent.length));
        sent = preview.answer;
      }
    }
  };

  try {
    for await (const chunk of r.body) consume(decoder.decode(chunk, { stream: true }));
  } catch (e) {
    return { ok: false, status: 0, error: `The answer stopped arriving: ${e.message}`, model };
  }
  return { ok: true, data: asm.finish(), model, streamed: true, ...(extra || {}) };
}

/* A turn that came back HTTP 200 and still has no usable answer in it.
 *
 * Neither of these is a failure as far as the transport is concerned, so
 * neither reaches friendlyError() below. From the owner's side they are the
 * same thing — no answer — and the reason is worth reading rather than
 * guessing at:
 *
 *   max_tokens  the ceiling was reached. On this model that ceiling covers the
 *               model's own thinking as well as the words it says, so a wide
 *               question can spend it all before it starts writing. The last
 *               block in the reply is cut mid-character; it may be half a
 *               sentence or half a tool call.
 *   refusal     the model's safety classifiers declined the request. The
 *               content is empty or partial and must not be shown as an answer.
 *
 * Returns null for every other stop reason, including the ones that are
 * perfectly normal (end_turn, tool_use) and the ones a stand-in leaves unset. */
export function stopReasonError(stopReason) {
  if (stopReason === 'max_tokens') {
    return 'That answer ran long and got cut off before I could finish it. Ask me for one part of it and I will have the room to answer properly.';
  }
  if (stopReason === 'refusal') {
    return 'I could not answer that one. Try asking it a different way, or ask about a part of your platform.';
  }
  return null;
}

/* A one-line, non-technical rendering of an Anthropic failure. The raw body is
   JSON full of provider jargon; the person reading this is not a developer. */
export function friendlyError(res) {
  const raw = String(res.error || '');
  if (res.status === 401) return 'The Anthropic key was rejected. Check it was copied in full and has not been revoked.';
  if (res.status === 429) return 'Anthropic is rate-limiting the key right now. Wait a minute and ask again.';
  if (res.status === 529 || res.status === 503) return 'Anthropic is busy or briefly unavailable. Try again in a moment.';
  if (res.status === 400 && /credit balance|billing/i.test(raw)) return 'The Anthropic account is out of credit. Top it up and try again.';
  if (res.status === 0) return raw;
  /* A 400 is Anthropic refusing the SHAPE of the request — which is a fact
     about this dashboard's own code, not about the owner or their platform, and
     is the one thing that makes the problem findable. Hiding it behind "(400)"
     left nothing to go on at all. */
  if (res.status === 400) {
    let why = '';
    try { why = JSON.parse(raw)?.error?.message || ''; } catch (_) { why = String(raw).slice(0, 200); }
    return 'The assistant sent a request Anthropic would not accept' +
      (why ? `: ${String(why).slice(0, 300)}` : '.') +
      ' This is a fault in the Mapper rather than anything you did — the wording above is what to report.';
  }
  return `The AI service returned an error (${res.status}). Try again; if it keeps happening the key or the account may need attention.`;
}
