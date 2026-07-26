/* HaTi-Mapper — sending one kind of email: the password reset.
 *
 * Same provider and the same fallback shape as HaTi. With RESEND_API_KEY set,
 * the mail goes out properly. Without it, the reset link is written to the
 * service log instead, because the alternative — a reset feature that silently
 * does nothing — would lock the owner out of their own tool permanently.
 *
 * That fallback is a deliberate trade and worth being clear about: anyone who
 * can read the service log can read the link while it is valid (30 minutes).
 * Set RESEND_API_KEY and the link never touches the log at all.
 */

export const emailConfigured = () => !!(process.env.RESEND_API_KEY || '').trim();

/* One place that actually posts to the provider, so the reset mail and the
   morning summary cannot drift apart in how they handle a refusal. */
async function send(to, subject, text) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY.trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'HaTi Mapper <onboarding@resend.dev>',
      to: [to],
      subject,
      text,
    }),
  });
  return r;
}

/* The morning summary. Unlike the reset link there is no fallback to the log:
   a summary is a convenience, and writing it into the service log every day
   would be noise rather than a rescue. Without a provider it simply does not
   go, and the dashboard shows the same report anyway. */
export async function sendDigestEmail(to, subject, body) {
  if (!emailConfigured()) return { sent: false, reason: 'no-email-provider' };
  try {
    const r = await send(to, subject, body);
    if (r.ok) {
      console.log(`[digest] the morning summary was emailed to ${to}.`);
      return { sent: true, provider: 'resend' };
    }
    const detail = await r.text().catch(() => '');
    console.warn(`[digest] Resend refused the summary (HTTP ${r.status}): ${detail.slice(0, 200)}`);
    return { sent: false, reason: 'resend-http-' + r.status };
  } catch (e) {
    console.warn(`[digest] the summary could not be sent (${e.message}).`);
    return { sent: false, reason: 'resend-error' };
  }
}

/* The same, for the "your scans keep failing" alert. */
export async function sendAlertEmail(to, subject, body) {
  if (!emailConfigured()) return { sent: false, reason: 'no-email-provider' };
  try {
    const r = await send(to, subject, body);
    if (r.ok) {
      console.log(`[alert] an alert was emailed to ${to}.`);
      return { sent: true, provider: 'resend' };
    }
    console.warn(`[alert] Resend refused the alert (HTTP ${r.status}).`);
    return { sent: false, reason: 'resend-http-' + r.status };
  } catch (e) {
    console.warn(`[alert] the alert could not be sent (${e.message}).`);
    return { sent: false, reason: 'resend-error' };
  }
}

export async function sendResetEmail(to, link, minutes) {
  const subject = 'Reset your HaTi Platform Map password';
  const body = [
    'Someone asked to reset the password for your HaTi Platform Map.',
    '',
    `Open this link to set a new password. It works once and expires in ${minutes} minutes:`,
    link,
    '',
    'If this was not you, ignore this email — nothing has changed, and whoever asked cannot get in without this link.',
  ].join('\n');

  if (!emailConfigured()) {
    // The only path by which the link is recoverable without an email provider.
    console.warn(
      `[auth] RESEND_API_KEY is not set, so no email was sent.\n` +
      `[auth] Password reset link for ${to} (valid ${minutes} minutes):\n` +
      `[auth]   ${link}\n` +
      `[auth] Set RESEND_API_KEY so this is emailed instead of logged.`);
    return { sent: false, provider: 'log', reason: 'no-email-provider' };
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'HaTi Mapper <onboarding@resend.dev>',
        to: [to],
        subject,
        text: body,
      }),
    });
    if (r.ok) {
      console.log(`[auth] reset email sent to ${to}.`);
      return { sent: true, provider: 'resend' };
    }
    const detail = await r.text().catch(() => '');
    console.warn(`[auth] Resend refused the reset email (HTTP ${r.status}): ${detail.slice(0, 200)}`);
    console.warn(`[auth] Reset link for ${to} (valid ${minutes} minutes): ${link}`);
    return { sent: false, provider: 'resend-http-' + r.status };
  } catch (e) {
    console.warn(`[auth] the reset email could not be sent (${e.message}).`);
    console.warn(`[auth] Reset link for ${to} (valid ${minutes} minutes): ${link}`);
    return { sent: false, provider: 'resend-error' };
  }
}
