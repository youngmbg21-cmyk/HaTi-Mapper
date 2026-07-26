/* HaTi-Mapper — what Anthropic charges. HAND-MAINTAINED.
 *
 * There is no way to read a price out of HaTi's source, and no endpoint that
 * reports one. So the numbers are written here, the same way the dependency
 * map and the phrasebook are, and the scan VALIDATES them on every run:
 *
 *   - a model HaTi is actually using with no entry here renders "price not on
 *     file" on the panel. It is never guessed from a similar-looking name.
 *   - an entry for a model nothing uses is reported as a stale warning.
 *   - if `asOf` is more than 90 days old, the panel says the prices may have
 *     moved. Prices change; this file does not update itself.
 *
 * Dollars per million tokens, from Anthropic's published list prices on the
 * date below. Deliberately incomplete: models whose price was not to hand are
 * left out rather than estimated, because "price not on file" is a useful
 * thing to see and a made-up number is not.
 *
 * To update: check the pricing page, change the numbers, change `asOf`.
 */

export const PRICING = {
  asOf: '2026-06-24',
  currency: 'USD',

  /* Keyed by the exact model id the scan finds in HaTi's source. Both the
     alias and the dated form are listed where HaTi might use either — a
     lookup is an exact match, never a prefix, so a new dated release shows up
     as "price not on file" rather than quietly inheriting an old price. */
  perMillionTokens: {
    'claude-fable-5': { input: 10, output: 50 },
    'claude-mythos-5': { input: 10, output: 50 },

    'claude-opus-5': { input: 5, output: 25 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },

    /* Sonnet 5 has a lower introductory rate until 31 August 2026. The list
       price is used here on purpose: this panel is a ceiling, and a ceiling
       built on a discount that expires is not one. */
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-sonnet-4-6': { input: 3, output: 15 },

    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  },
};

/* How long a price list is trusted before the panel starts saying it might be
   out of date. Three months is long enough not to nag and short enough that a
   real change is noticed. */
export const STALE_AFTER_DAYS = 90;
