# Security

## What is protected

- Passwords are hashed with scrypt and a per-user salt
- Sessions are server-side behind an httpOnly cookie
- Share links are single-response and expire

## Known limitations

- **Share tokens are long-lived until used.** A link that is never opened stays valid until its expiry date, so a forwarded link is as good as the original.
- **No rate limit on the advice portal upload.** The request form accepts attachments without a size ceiling beyond the body parser default.
- **The audit trail can be read by any workspace member.** Roles gate writing, not reading, so anyone signed in can see who did what.
- **Backups are the hosting provider disk snapshot only.** There is no application-level export, so a restore is all-or-nothing.

## Reporting

- Open a private issue on the repository
