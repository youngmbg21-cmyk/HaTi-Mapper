/* HaTi-Mapper — the handful of choices the owner makes and expects to stick.
 *
 * Whether to be emailed a morning summary, which tripwires are armed and at
 * what thresholds, and the small amount of bookkeeping those need — when the
 * last digest went out, how many scans have failed in a row, which alerts have
 * been dismissed.
 *
 * One JSON file in MAPPER_DATA, same pattern as everything else here: read on
 * boot, written on change, and if the directory cannot be written it says so
 * once and carries on in memory rather than failing. Nothing in it is secret —
 * no key, no address, no token — so it is stored plainly.
 */

import fs from 'node:fs';
import path from 'node:path';

/* Every rule ships with a threshold and a default position. The two that are
   on by default are the two that are about somebody else being able to read
   HaTi's data; the rest are about cost and tidiness, and being nagged about
   those unasked would only teach the owner to ignore the banner. */
export const WATCH_DEFAULTS = {
  openRoute: { on: true, threshold: null },
  publicLink: { on: true, threshold: null },
  fileSize: { on: false, threshold: 100 },      // KB
  aiRequests: { on: false, threshold: 150 },    // per day, live HaTi only
  scanHealth: { on: false, threshold: 90 },     // percent
};

const DEFAULTS = {
  /* How much machine detail the assistant's answers carry: 'plain' or
     'technical'. Kept on the server as well as in the browser because whoever
     needs plain needs it on every device, not just the one they set it on. */
  answerRegister: 'plain',
  digestEmail: false,
  lastDigestDate: null,       // 'YYYY-MM-DD', so it goes out once a day
  watch: WATCH_DEFAULTS,
  tripped: [],                // rules currently showing a banner
  failedScans: 0,             // consecutive
  failedSince: null,
  failedReason: null,
  scanAlertSent: false,       // so a broken scan does not email every ten minutes
};

const clone = v => JSON.parse(JSON.stringify(v));

export class Prefs {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'prefs.json') : null;
    this.data = clone(DEFAULTS);
    this.writable = true;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...clone(DEFAULTS),
        ...raw,
        // Merge rule by rule, so a rule added in a later version arrives with
        // its default rather than being missing from an older file.
        watch: Object.fromEntries(Object.entries(WATCH_DEFAULTS).map(([k, def]) => [k, { ...def, ...(raw.watch?.[k] || {}) }])),
      };
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[prefs] your settings could not be read:', e.message);
    }
  }

  _save() {
    if (!this.file || !this.writable) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (e) {
      this.writable = false;
      console.warn('[prefs] your settings cannot be written to disk, so they will be lost on restart:', e.message);
    }
  }

  all() { return clone(this.data); }
  get(key) { return this.data[key]; }

  update(partial) {
    this.data = { ...this.data, ...partial };
    this._save();
    return this.all();
  }

  /* Rules come in from the page one at a time and are validated here rather
     than trusted: an unknown rule name is ignored, and a threshold that is not
     a sensible number keeps the one it had. */
  setRule(name, patch) {
    if (!WATCH_DEFAULTS[name]) return false;
    const cur = this.data.watch[name] || { ...WATCH_DEFAULTS[name] };
    const next = { ...cur };
    if (typeof patch.on === 'boolean') next.on = patch.on;
    if (WATCH_DEFAULTS[name].threshold !== null && patch.threshold != null) {
      const n = Number(patch.threshold);
      if (Number.isFinite(n) && n > 0) next.threshold = Math.round(n);
    }
    this.data.watch = { ...this.data.watch, [name]: next };
    this._save();
    return true;
  }

  get durable() { return this.writable && !!this.file; }
}
