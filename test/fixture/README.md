# HaTi

Contract lifecycle management for the Kenyan market. One Express service, one
SQLite file, no build step.

## What it does

- Draft, review, sign and store contracts in one place
- Share a contract with a counterparty for review and signature
- Track renewals, expiries and notice deadlines

## Honest limitations

- **Rich text is stored as HTML.** The editor writes a subset of HTML and the seal is taken over that string, so any change to how the text is stored has to keep every signed contract verifying.
- **The mobile counterparty portal is not built.** A counterparty on a phone gets the desktop layout scaled down, which works but is not comfortable for a long document.
- **Bulk import has no undo.** Once a batch is accepted the contracts are in the register, and removing them is a row-by-row job.
- **Obligation extraction misses tables.** Payment schedules laid out as tables are frequently read as one long paragraph, so the dates come back wrong.
- **There is no audit export.** The trail is visible on screen and inside the evidence pack, but there is no way to hand a regulator a standalone file.
- **Search does not cover attachments.** Only the contract body and the extracted details are indexed, so a term that appears only in an annexe will not be found.

## Running it

npm install, then npm start.
