/* HaTi-Mapper — the owner account.
 *
 * One account, because this is one person's view of their own platform. Same
 * approach HaTi uses for its own users: scrypt password hashing with a random
 * salt, server-side sessions behind an httpOnly cookie, and single-use expiring
 * reset tokens of which only a hash is ever stored.
 *
 * Everything lives in one JSON file under the state directory. That is enough
 * for a single-owner internal tool and keeps the Mapper dependency-free — but
 * it means the file IS the account, so the state directory should be on a
 * persistent disk if you want the login to survive a redeploy. The README says
 * so, and the page says so when it is running without one.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_DAYS = 30;
const RESET_MINUTES = 30;
const MIN_PASSWORD = 8;

/* Per-address limiting stops one machine guessing quickly. It does nothing
   about a patient attacker spread across many addresses, because each one
   arrives with a fresh bucket. So the account keeps its own count: ten wrong
   passwords in a row, from anywhere at all, and it stops answering for a
   while. A correct password clears it, and the count is written to disk so a
   restart is not a way to wipe it. */
const MAX_LOGIN_FAILURES = 10;
const LOCK_MINUTES = (() => {
  const n = Number(process.env.LOGIN_LOCK_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 15;
})();

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

export const normaliseEmail = e => String(e || '').trim().toLowerCase();
export const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normaliseEmail(e));

export class Accounts {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'account.json') : null;
    this.data = { owner: null, sessions: [], resets: [], login: { failures: 0, until: 0 } };
    this.writable = true;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        owner: raw.owner || null,
        sessions: raw.sessions || [],
        resets: raw.resets || [],
        login: {
          failures: Number(raw.login?.failures) || 0,
          until: Number(raw.login?.until) || 0,
        },
      };
      this._prune();
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[auth] could not read the account file:', e.message);
    }
  }

  _save() {
    if (!this.file || !this.writable) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    } catch (e) {
      this.writable = false;
      console.warn('[auth] the account cannot be written to disk, so the login will be lost on restart:', e.message);
    }
  }

  _prune() {
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter(s => s.expires > now);
    this.data.resets = this.data.resets.filter(r => r.expires > now && !r.used);
  }

  /* ------------------------------------------------------------- state */

  get claimed() { return !!this.data.owner; }
  get ownerEmail() { return this.data.owner ? this.data.owner.email : null; }
  get durable() { return this.writable && !!this.file; }

  /* --------------------------------------------------------- registering */

  /* Claim the account. `allowedEmail` (from MAPPER_OWNER_EMAIL) restricts who
     may do this; without it the first person to arrive claims it, which is why
     the page tells you to do it immediately. */
  register(email, password, allowedEmail) {
    if (this.claimed) return { error: 'This Mapper already has an owner. Sign in instead.' };
    const e = normaliseEmail(email);
    if (!validEmail(e)) return { error: 'That does not look like an email address.' };
    if (allowedEmail && e !== normaliseEmail(allowedEmail)) {
      return { error: 'That email address is not the one this Mapper is set up for.' };
    }
    const bad = this.checkPassword(password);
    if (bad) return { error: bad };

    const salt = rid(16);
    this.data.owner = { email: e, salt, hash: hashPw(password, salt), createdAt: new Date().toISOString() };
    this._save();
    return { ok: true, email: e };
  }

  checkPassword(password) {
    const p = String(password || '');
    if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
    if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Use at least one letter and one number.';
    return null;
  }

  /* ------------------------------------------------------------- signing in */

  verify(email, password) {
    const o = this.data.owner;
    if (!o) return false;
    if (normaliseEmail(email) !== o.email) return false;
    return safeEq(hashPw(password || '', o.salt), o.hash);
  }

  /* ------------------------------------------------ too many wrong tries */

  /* Null when a sign-in may be attempted, or the sentence to show when it may
     not. Written for someone who is probably just mistyping their own
     password, so it says what to do rather than what went wrong. */
  loginBlock() {
    const until = this.data.login.until || 0;
    if (!until) return null;
    const left = until - Date.now();
    if (left <= 0) {
      // The window has passed. Start the count again from nothing.
      this.data.login = { failures: 0, until: 0 };
      this._save();
      return null;
    }
    const minutes = Math.max(1, Math.ceil(left / 60000));
    return `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }

  /* Returns how many are left before the account stops answering, so the
     caller can log it. Zero means this failure closed the door. */
  noteFailedLogin() {
    const login = this.data.login;
    login.failures = (login.failures || 0) + 1;
    if (login.failures >= MAX_LOGIN_FAILURES) login.until = Date.now() + LOCK_MINUTES * 60 * 1000;
    this._save();
    return Math.max(0, MAX_LOGIN_FAILURES - login.failures);
  }

  noteSuccessfulLogin() {
    if (!this.data.login.failures && !this.data.login.until) return;
    this.data.login = { failures: 0, until: 0 };
    this._save();
  }

  get loginFailures() { return this.data.login.failures || 0; }

  createSession(meta = {}) {
    const token = rid(32);
    this.data.sessions.push({
      token,
      createdAt: new Date().toISOString(),
      expires: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
      ip: meta.ip || null,
      agent: String(meta.agent || '').slice(0, 160) || null,
    });
    this._prune();
    this._save();
    return token;
  }

  sessionFor(token) {
    if (!token) return null;
    const s = this.data.sessions.find(x => x.token === token);
    if (!s) return null;
    if (s.expires <= Date.now()) { this.endSession(token); return null; }
    return s;
  }

  endSession(token) {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(s => s.token !== token);
    if (this.data.sessions.length !== before) this._save();
  }

  endAllSessions() {
    this.data.sessions = [];
    this._save();
  }

  get sessionCount() { return this.data.sessions.length; }

  /* --------------------------------------------------------- resetting */

  /* Returns the one-time link fragment. The caller emails it; only its hash is
     kept here, so a copy of the account file cannot be used to reset. */
  startReset(email) {
    const o = this.data.owner;
    if (!o || normaliseEmail(email) !== o.email) return null;   // caller must not reveal this
    const id = 'r_' + rid(6);
    const token = rid(16);
    this.data.resets.push({ id, tokenHash: sha(token), expires: Date.now() + RESET_MINUTES * 60 * 1000, used: false });
    this._prune();
    this._save();
    return { fragment: `${id}.${token}`, minutes: RESET_MINUTES };
  }

  completeReset(fragment, password) {
    const [id, raw] = String(fragment || '').split('.');
    const row = this.data.resets.find(r => r.id === id);
    if (!row || row.used || row.expires <= Date.now() || !safeEq(row.tokenHash, sha(raw || ''))) {
      return { error: 'That reset link is no longer valid. Ask for a new one.' };
    }
    const bad = this.checkPassword(password);
    if (bad) return { error: bad };

    const salt = rid(16);
    this.data.owner.salt = salt;
    this.data.owner.hash = hashPw(password, salt);
    row.used = true;
    this.data.sessions = [];      // a reset signs every device out
    // Whoever did this proved they can read the owner's email, so the count of
    // wrong guesses is no longer about them. Clearing it stops a locked-out
    // owner having to wait after resetting.
    this.data.login = { failures: 0, until: 0 };
    this._prune();
    this._save();
    return { ok: true };
  }

  changePassword(current, next) {
    const o = this.data.owner;
    if (!o) return { error: 'There is no account yet.' };
    if (!safeEq(hashPw(current || '', o.salt), o.hash)) return { error: 'That is not your current password.' };
    const bad = this.checkPassword(next);
    if (bad) return { error: bad };
    if (String(next) === String(current)) return { error: 'Choose a password you have not used here before.' };

    const salt = rid(16);
    o.salt = salt;
    o.hash = hashPw(next, salt);
    this._save();
    return { ok: true };
  }
}

export { SESSION_DAYS, RESET_MINUTES, MIN_PASSWORD, MAX_LOGIN_FAILURES, LOCK_MINUTES };
