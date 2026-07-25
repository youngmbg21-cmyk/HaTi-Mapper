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

/* A one-line, non-technical rendering of an Anthropic failure. The raw body is
   JSON full of provider jargon; the person reading this is not a developer. */
export function friendlyError(res) {
  const raw = String(res.error || '');
  if (res.status === 401) return 'The Anthropic key was rejected. Check it was copied in full and has not been revoked.';
  if (res.status === 429) return 'Anthropic is rate-limiting the key right now. Wait a minute and ask again.';
  if (res.status === 529 || res.status === 503) return 'Anthropic is busy or briefly unavailable. Try again in a moment.';
  if (res.status === 400 && /credit balance|billing/i.test(raw)) return 'The Anthropic account is out of credit. Top it up and try again.';
  if (res.status === 0) return raw;
  return `The AI service returned an error (${res.status}). Try again; if it keeps happening the key or the account may need attention.`;
}
