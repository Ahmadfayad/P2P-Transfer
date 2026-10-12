# Document Exchange

A private document handover between university staff and approved students. Employees sign in; students enter through a desk QR invitation without accounts. WebRTC provides direct transfers when available; encrypted HTTPS chunks provide recovery when direct routes are blocked. Cloudflare Workers Free hosts transfers; Neon Free stores accounts. No paid TURN provider, domain or subscription is required.

[Open the deployed service](https://uos-document-exchange.uos-document-exchange.workers.dev). Initial administrator credentials are supplied privately and never committed. The [original audit](docs/AUDIT.md) documents the former security and reliability problems.

## Accounts and administration

Public registration is disabled. Admins manage users; staff open desks; students join invited desks. Desk administration requires an employee account. QR guests use a private peer token and must be approved by staff. An invitation cannot grant staff privileges, and copied desk credentials cannot bypass account ownership.

Students never see employee login, including before scripts load or after refresh. An invitation opens a name/student-ID popup, followed by a waiting screen that keeps file controls inaccessible until staff approve. Staff receive queued approval popups showing the self-reported label, with Approve and Reject actions. Students can cancel their own request; an ended request cannot be revived by a stale approval. Refresh restores the same request without creating another visitor. Connection diagnostics remain accessible while waiting.

Open **Manage users** (`/admin.html`). Choose **Add user** to create an account manually with a name, email, role and temporary password. The role description explains each permission level. For bulk creation, upload a CSV with exactly `email,name,role,password`, review its preview, then import. Employee roles are `admin` and `staff`; students have no login accounts; passwords contain **6–128 characters**. The server rejects shorter passwords. Import at most 200 rows per file. Quoted names, commas, Unicode and spreadsheet CSV files are supported; duplicate emails and malformed rows are rejected before import begins. The preview does not display passwords.

Existing accounts are reported and kept unchanged. An interrupted import reports completed and failed rows; reimporting does not overwrite existing passwords or roles. Admins can change roles, disable non-admin accounts and reset passwords. Disabling and password resets revoke existing sign-ins. Administrator accounts are protected against these controls to prevent accidental lockout. Users can change their own passwords.

Share passwords privately and delete your CSV copy when finished. Account creation does not send email or verify university mailbox ownership. Imported accounts are controlled by the administrator and are not university SSO. No paid email provider is needed.

## Transfers and recovery

Staff sign in, enter a desk name and share the generated QR code. Students open that invitation and enter their name or student ID without signing in. Staff approve each connection before files can be exchanged. Keep both pages open until **Received ✓**: the receiver has verified and saved the complete document. This does not mean the person downloaded or read it. Use **Save a copy** before clearing browser data or removing a file.

Use separate devices or browser profiles for a desk and its student. Tabs retain their own role on refresh. A staff tab may visit another desk; it cannot join its own desk and mix sender/receiver storage.

Verified chunks are saved in IndexedDB before acknowledgement. Interrupted transfers retry from their saved offset. Completed incoming files and original outgoing files remain locally available after the session ends. **Send again** starts a new transfer across expired sessions. A final receipt is never issued for a document that was not fully assembled and saved.

A failed file retries independently with backoff and shows its error beside that file; other documents can continue. Ending a visitor connection releases an active slot and closes its direct channel when the browser next observes revoked approval. Received files and visitor history remain available.

Files and encryption keys are separated by account in the browser. Sign-out hides them, and another person's login cannot display them. **Recover earlier files** can claim this browser's files from before sign-in into one account, retaining the original copy. Valid old room credentials can be bound to that account once. Recover only files belonging to you. Browser storage is not a backup.

## Implementation

Better Auth 1.7.7 stores users, hashed credentials and sessions in Neon's PostgreSQL database. Managed Neon Auth rejected six-character passwords during testing, so this deployment uses self-managed Better Auth with `minPasswordLength: 6`. Passwords are HMAC-peppered and bcrypt-hashed at cost 12 in PostgreSQL (`pgcrypto`); expensive hashing does not consume the free Worker's CPU allowance. Plaintext passwords are not stored. Login limits are atomic per email (10 attempts/minute), with a broader shared-IP limit suitable for university NAT.

The QR fragment pins the desk public-key fingerprint and carries an invitation secret, never the private desk token. ECDH-derived AES-GCM keys encrypt document chunks in the browsers, binding room, participants, filename, size and chunk position. Cloudflare holds metadata and bounded encrypted chunks; it does not receive plaintext files or browser encryption keys. Compromised site JavaScript remains a threat.

PDF and image previews use fixed canonical MIME types. HTML and SVG are not embedded as executable documents. DOCX is download-only and checked as a ZIP container. This is not an antivirus or content scanner. The QR library is bundled locally with its MIT notices; no external script/CSS CDN is required.

## Connection diagnostics and work PC

Expand **Connection help & system log** and select the affected network before downloading the JSON. Export from both sender and receiver when possible. The browser retains the last 1,200 events across refreshes in that tab; server records retain at most 2,000 entries for up to 24 hours. Logs include HTTP timing/status/correlation IDs, retries, network changes, WebRTC state and transfer offsets. Staff can export their room server records; admins can export recent system errors. Passwords, invitation keys, document contents and filenames are excluded. Export promptly after the problem; closing the tab can clear its local log.

Diagnostic format 2 uses known route templates and error categories, never free-form exception messages. Previously saved browser events and server routes are sanitized again before export.

See [the work-PC handoff](docs/PROJECT-HANDOFF.md) to continue from the same GitHub branch. Local project folders are not copied between computers by conversation sync.

## Run locally

Use Node.js 24+, then `npm ci`. Create an untracked `.dev.vars` with:

```
DATABASE_URL=your-dedicated-Neon-connection-string
BETTER_AUTH_URL=http://127.0.0.1:8788
BETTER_AUTH_SECRET=your-cryptographically-random-secret-of-at-least-32-characters
```

Run `node scripts/setup-auth.mjs` to install the additive schema and initial administrator. Set `ADMIN_EMAIL` first for another deployment. Setup generates a secret if absent and saves initial credentials outside Git in `../ADMIN-ACCESS-PRIVATE.txt`. Existing administrator passwords are left unchanged. Run `npx wrangler dev --port 8788`. Open exactly the configured origin; browser crypto needs HTTPS or localhost.

Run `npm run check` and `npm test`. Real browser checks: install Chromium (`npx playwright install chromium`), start the app, then set `TEST_URL=http://127.0.0.1:8788` and run `npm run test:browser`. `CHROME_PATH` can point to installed Chrome. Tests create random accounts, remove their temporary accounts afterwards. Account tests use the private initial administrator credentials; update that local file if you change that test administrator's password.

Checks cover CSV validation, six-character login, role enforcement, password changes/resets, disabling accounts, reload, account isolation, recovery of earlier files, authenticated relay, exact file bytes, offline/refresh recovery, lost acknowledgements, direct-to-HTTPS recovery, reverse transfers and safe previews.

`npm run test:reliability` runs a separate loopback SQLite relay and real Chromium browsers without deployment secrets or real accounts. It checks that a broken first transfer does not block a healthy file, exact saved bytes survive refresh and a lost acknowledgement, and stale signaling after revocation cannot reopen a direct connection. Use `CHROME_PATH` if the installed browser differs from Playwright's bundled version.

## Free deployment

Use Cloudflare Workers Free. Replace `account_id` in `wrangler.jsonc` for another account and run `npx wrangler login`. Store `DATABASE_URL` and `BETTER_AUTH_SECRET` with `npx wrangler secret put`, then `npm run deploy`. Set `BETTER_AUTH_URL` to the live Cloudflare origin. Local `.dev.vars` is not uploaded. Do not rotate the auth secret without a password migration: it also peppers password hashes. The old `DESK_SETUP_KEY` is unused.

Vercel Hobby can serve `public/` and proxy `/api/*` to Cloudflare through `vercel.json`. Register each exact Vercel origin in `FRONTEND_ORIGINS`; arbitrary origins remain blocked. `.vercelignore` uploads only static assets and configuration. Database credentials belong only in Cloudflare secrets. Enable **Web Analytics** in the Vercel dashboard. Its script loads only on Vercel addresses and excludes query parameters/fragments. Account names, emails, passwords and file metadata are not sent as analytics events. Analytics activation and production promotion are separate steps.

## Limits and remaining risks

- PDF, DOCX, PNG and JPG; 150 MiB/file; 300 MiB reserved local files; eight-hour rooms; ten desks; twenty active/pending students per desk; two hundred visitor history records and one hundred transfers per room. Ended visitors release an active slot without deleting history. One small relay hub serves this deployment.
- Remote buffering is bounded to 32 MiB and four chunks per transfer. Expired metadata/chunks are cleaned by an alarm. Idle polling is fifteen seconds; active polling slows when progress stops. Failed requests back off. Direct negotiation is capped at three attempts/peer/page; HTTPS remains available.
- Free Cloudflare, Neon and Vercel quotas are shared with other projects. Exhausted quotas or provider outages can interrupt service; no paid capacity or upgrades are configured. Neon is required for authenticated API access, and a cold database can add latency.
- Sleeping devices, closed tabs, browser eviction, cleared site data and network outages can prevent continuation. Save received documents to permanent storage.
- If IT blocks the HTTPS address, the application cannot guarantee connectivity. Test the actual campus network. An IT-approved address is the dependable solution when domains are blocked.
- Browser checks use desktop Chromium and a phone-sized viewport. Real campus Wi-Fi/Ethernet, real phones/Safari and simultaneous university-scale load still need a pilot.

Provider references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Neon pricing](https://neon.com/pricing), [Vercel Analytics pricing](https://vercel.com/docs/analytics/limits-and-pricing).

## Source layout

- `public/app.js`, `index.html`, `style.css`: transfer interface and lifecycle.
- `public/account.js`, `admin.html`, `admin.js`, `user-csv.js`: login and administration.
- `public/transfer.js`, `direct.js`: persisted queue, receipts and optional direct connection.
- `public/storage.js`, `crypto.js`, `protocol.js`: account storage, encryption and validation.
- `server/worker.js`: protected API, approval, relay, limits and expiry.
- `server/auth.js`, `auth-schema.sql`: authentication and database schema.
- `tests/`: security, permissions and browser recovery checks.

The root `index.html` is a migration landing page. GitHub Pages cannot run the new API. The original public-signaling protocol cannot connect to this version; save needed documents from old tabs before closing or refreshing them, then create new invitations. Legacy chat is not included. The original implementation is preserved at commit `2fe23dea44b5ddce4ee27996dd0f3374e1d96248`.
