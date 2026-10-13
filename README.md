# Document Exchange

A private document handover between university staff and approved students. Employees sign in; students enter through a desk QR invitation without accounts. WebRTC pipelines encrypted frames when available; a continuous encrypted HTTPS receive stream is available when direct routes fail. New document contents are never written to server SQLite or browser IndexedDB. Cloudflare Workers Free hosts transfers; Neon Free stores accounts. No paid TURN provider, domain or subscription is required.

[Open the deployed service](https://uos-file-transfer.vercel.app). Initial administrator credentials are supplied privately and never committed. The [original audit](docs/AUDIT.md) documents the former security and reliability problems.

## Accounts and administration

Public registration is disabled. Admins manage users; staff open desks; students join invited desks. Desk administration requires an employee account. QR guests use a private peer token and must be approved by staff. An invitation cannot grant staff privileges, and copied desk credentials cannot bypass account ownership.

Students never see employee login, including before scripts load or after refresh. An invitation opens a name/student-ID popup, followed by a waiting screen that keeps file controls inaccessible until staff approve. Staff receive queued approval popups showing the self-reported label, with Approve and Reject actions. Students can cancel their own request; an ended request cannot be revived by a stale approval. A staff desk stays open for its work session (up to eight hours); each student connection lasts ten minutes, with up to two minutes of grace only for an already accepted transfer. Private transfer credentials remain in page memory. Refresh requires scanning a fresh invitation and resending unfinished transfers; employee login remains signed in. Connection diagnostics remain accessible while waiting.

Students see a rotating indicator while checking or waiting for approval; reduced-motion preferences are respected. The staff list shows active and pending connections, with ended requests grouped in a collapsed section. A returning name/ID is flagged for identity checking and requires fresh approval. A previously inactive peer that resumes polling is marked as reconnected in that staff page. Matching self-reported labels do not establish identity or merge file ownership.

Open **Manage users** (`/admin.html`). Choose **Add user** to create an account manually with a name, email, role and temporary password. The role description explains each permission level. For bulk creation, upload a CSV with exactly `email,name,role,password`, review its preview, then import. Employee roles are `admin` and `staff`; students have no login accounts; passwords contain **6–128 characters**. The server rejects shorter passwords. Import at most 200 rows per file. Quoted names, commas, Unicode and spreadsheet CSV files are supported; duplicate emails and malformed rows are rejected before import begins. The preview does not display passwords.

Existing accounts are reported and kept unchanged. An interrupted import reports completed and failed rows; reimporting does not overwrite existing passwords or roles. Admins can change roles, disable non-admin accounts and reset passwords. Disabling and password resets revoke existing sign-ins. Administrator accounts are protected against these controls to prevent accidental lockout. Users can change their own passwords.

Share passwords privately and delete your CSV copy when finished. Account creation does not send email or verify university mailbox ownership. Imported accounts are controlled by the administrator and are not university SSO. No paid email provider is needed.

## Transfers and recovery

Staff sign in, enter their physical desk location, print its permanent QR once, and open the desk named from their employee profile. The same printed QR resolves fresh transfer keys each work session; admins can reassign staff while keeping the physical QR, or replace a copied code. Students scan the physical QR, confirm the displayed staff name/location, and enter their name and student ID without an account or email field. A locked waiting screen remains until staff approve or reject them. Approved visitors exchange files in either direction: incoming files are accepted and verified automatically, with no Receive & save button. Images show a thumbnail; images and PDFs can be previewed; DOCX can be downloaded. **Received—download to keep it** means every frame was authenticated and the complete byte count was verified; it is still a temporary file. **Download initiated** means the browser download was requested, without proof of disk save. Existing legacy disk-save receipts remain readable.

Use separate devices or browser profiles for a desk and its student. Refresh does not restore a desk or guest transfer session. A staff tab may visit another desk; it cannot join its own desk and mix sender/receiver storage.

New transfers use temporary buffers only: up to 150 MiB per file and 300 MiB total reserved plaintext across pending/completed incoming files per page. Blob construction can briefly hold another bounded copy. Download and remove received files to release capacity; a full budget rejects the next offer with a resend instruction. Original selected files are read in slices and never copied into IndexedDB. Download verified files before closing or refreshing: new temporary files cannot be recovered after that. Browsers need a user gesture for a disk picker, so reception does not open one.

All existing account databases, saved original files, verified legacy chunks and earlier-file recovery remain intact. No storage reset or destructive migration is performed. Persistent upload endpoints reject new writes, while legacy saved-file reads remain available. Export receipts includes current temporary transfer metadata and older saved-file receipts.

Earlier saved files and their legacy session encryption keys remain separated by account in the browser; new session keys and credentials are never persisted. New transfer buffers belong to the current page and are discarded when it closes. Sign-out hides them, and another person's login cannot display them. **Recover earlier files** can claim this browser's files from before sign-in into one account, retaining the original copy. Valid old room credentials can be bound to that account once. Recover only files belonging to you. Browser storage is not a backup.

## Implementation

Better Auth 1.7.7 stores users, hashed credentials and sessions in Neon's PostgreSQL database. Managed Neon Auth rejected six-character passwords during testing, so this deployment uses self-managed Better Auth with `minPasswordLength: 6`. Passwords are HMAC-peppered and bcrypt-hashed at cost 12 in PostgreSQL (`pgcrypto`); expensive hashing does not consume the free Worker's CPU allowance. Plaintext passwords are not stored. Login limits are atomic per email (10 attempts/minute), with a broader shared-IP limit suitable for university NAT.

The QR fragment pins the desk public-key fingerprint and carries an invitation secret, never the private desk token. ECDH-derived AES-GCM keys encrypt document chunks in the browsers, binding room, participants, filename, size and chunk position. Cloudflare stores student name/email/ID and filenames plus necessary transfer, authorization and receipt metadata; it forwards only encrypted document bytes through bounded temporary streams. It receives no plaintext documents or browser encryption keys. Existing legacy chunk storage is preserved, but the new path does not write to it. Compromised site JavaScript remains a threat.

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

Run `npm run check` and `npm test`. Real browser checks: install Chromium (`npx playwright install chromium`), start the app, then set `TEST_URL=http://127.0.0.1:8788` and run `npm run test:browser`. Firefox/WebKit compatibility checks run `tests/stream-browser.mjs` with `BROWSER=firefox` or `webkit`, `COMPAT_ONLY=1`, and installed Playwright engines. `CHROME_PATH` can point to installed Chrome. Tests create random accounts, remove their temporary accounts afterwards. Tests create their own temporary admin/staff fixtures using private local database authentication; they do not need or change a real administrator password.

Checks cover CSV validation, six-character login, role enforcement, password changes/resets, disabling accounts, reload, account isolation, recovery of earlier files, authenticated stream access, short-lived employee leases, lease revocation, exact bytes, stalled/slow receivers, refresh/resend behavior, direct-to-HTTPS fallback, bounded temporary memory and safe legacy previews. See [streaming verification](docs/STREAMING.md) for transport rationale and measured results.

`npm run test:reliability` runs a separate loopback SQLite relay and real Chromium browsers without deployment secrets or real accounts. It checks that a broken first transfer does not block a healthy file, exact saved bytes survive refresh and a lost acknowledgement, and stale signaling after revocation cannot reopen a direct connection. Use `CHROME_PATH` if the installed browser differs from Playwright's bundled version.

## Free deployment

Use Cloudflare Workers Free. Replace `account_id` in `wrangler.jsonc` for another account and run `npx wrangler login`. Store `DATABASE_URL` and `BETTER_AUTH_SECRET` with `npx wrangler secret put`, then `npm run deploy`. Set `BETTER_AUTH_URL` to the live Cloudflare origin. Local `.dev.vars` is not uploaded. Do not rotate the auth secret without a password migration: it also peppers password hashes. The old `DESK_SETUP_KEY` is unused.

Vercel Hobby can serve `public/` and proxy `/api/*` to Cloudflare through `vercel.json`. Register each exact Vercel origin in `FRONTEND_ORIGINS`; arbitrary origins remain blocked. `.vercelignore` uploads only static assets and configuration. Database credentials belong only in Cloudflare secrets. Enable **Web Analytics** in the Vercel dashboard. Its script loads only on Vercel addresses and excludes query parameters/fragments. Account names, emails, passwords and file metadata are not sent as analytics events. Analytics activation and production promotion are separate steps.

## Limits and remaining risks

- PDF, DOCX, PNG and JPG; 150 MiB/file; 300 MiB total temporary received files per page; eight-hour staff work sessions; ten-minute visitors with bounded two-minute transfer grace; ten desks; twenty students/desk; one hundred transfers/room. One small relay hub serves this deployment.
- Four simultaneous HTTPS relay streams; upload windows contain at most eight 512 KiB encrypted frames (about 4 MiB). The relay forwards in 64 KiB writes with backpressure and a 45-second inactivity/stall deadline. WebRTC uses a four-frame credit window and a bounded inbox; slow or broken direct routes fall back to HTTPS. Failed requests back off. Direct negotiation is capped at three attempts/peer/page.
- Metadata changes wake a bounded 20-second long poll; idle pages do not repeatedly retrieve document chunks. At most 100 metadata waiters are admitted. Staff authenticate a room-scoped 90-second memory lease and renew on approximately 30–40-second control cycles; data windows and updates validate that capability without another Neon query. App sign-out, role/password changes and account disabling revoke leases and interrupt active transfers. Identity changes made outside this app are bounded by lease expiry/renewal.
- Free Cloudflare, Neon and Vercel quotas are shared with other projects. Exhausted quotas or provider outages can interrupt service; no paid capacity or upgrades are configured. Neon is required for employee sign-in and lease renewal; a cold database can add latency. Never increase this deployment to a paid plan automatically.
- Sleeping devices, closed tabs, runtime eviction, network interruption and browser eviction require resending unfinished new transfers. Confirm disk saves before closing temporary-download pages. Existing earlier saved documents remain in their original browser storage.
- If IT blocks the HTTPS address, the application cannot guarantee connectivity. Test the actual campus network. An IT-approved address is the dependable solution when domains are blocked.
- Browser checks use desktop Chromium and a phone-sized viewport. Real campus Wi-Fi/Ethernet, real phones/Safari and simultaneous university-scale load still need a pilot.

Provider references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Neon pricing](https://neon.com/pricing), [Vercel Analytics pricing](https://vercel.com/docs/analytics/limits-and-pricing).

## Source layout

- `public/app.js`, `index.html`, `style.css`: transfer interface and lifecycle.
- `public/account.js`, `admin.html`, `admin.js`, `user-csv.js`: login and administration.
- `public/stream-transfer.js`, `direct.js`: temporary queue, verified streaming, disk/download receipts and optional direct pipeline. `public/transfer.js` retains the request helper and legacy saved-file assembly.
- `public/storage.js`, `crypto.js`, `protocol.js`: account storage, encryption and validation.
- `server/worker.js`, `stream-relay.js`: protected API, approval, memory leases, continuous relay, backpressure, revocation, limits and expiry.
- `server/auth.js`, `auth-schema.sql`: authentication and database schema.
- `tests/`: security, permissions and browser recovery checks.

The root `index.html` is a migration landing page. GitHub Pages cannot run the new API. The original public-signaling protocol cannot connect to this version; save needed documents from old tabs before closing or refreshing them, then create new invitations. Legacy chat is not included. The original implementation is preserved at commit `2fe23dea44b5ddce4ee27996dd0f3374e1d96248`.

## Initial automatic handover update, 13 October 2026 (superseded below)

Incoming files now load automatically on both sides after connection approval. Staff see green for recent authenticated page activity, amber for pending/retrying/stale activity, and red for ended or inactive pages. These lights are heartbeat estimates, not proof of a physical network link. A single approved student is selected automatically as recipient; multiple students still require selecting the intended recipient.

The original university/registrar logo is bundled locally. Students see a mobile-friendly file-first layout and the employee profile name, with a Change desk action to withdraw the old connection and scan or paste the next staff invitation. New desk and guest credentials/invitations are held only in memory. Existing saved documents and legacy session records are preserved; employee login is independent of the ten-minute transfer session.

## Permanent printed desks and simpler handover

Each physical desk has a persistent invitation ID/code and an assigned employee. Initially an employee is provisioned one desk; set its number/location and use **Print desk QR**. The print sheet uses the physical location, not the employee name, so staff reassignment does not require changing the printed QR. QR contents stay the same across closing, reopening and signing in. Transfer public keys and private owner credentials are fresh on each opening. A printed invitation alone never approves a student or grants file access.

Students scan with their phone camera; before requesting approval they see the staff name and desk location. Closed desks display an unavailable message and a Check desk again button. **Change desk** ends the local connection immediately and asks the student to scan the physical QR at their next seat. There is no URL input. Network failure does not trap them in the previous desk. Name and student ID are separate required fields; email is not requested.

Staff work sessions stay open up to eight hours and close on explicit ending, sign-out, password change, disablement or reassignment. Visitors receive their own ten-minute deadline. A countdown warns during the last minute; staff can Extend 10 minutes for an approved visitor. After the normal deadline no new offers are allowed. An already accepted transfer may finish for at most two extra minutes, then the visitor must scan again. Staff can end one visitor without ending other visitors or the desk. These rules are checked on the server as well as in the interface.

Files arrive automatically after one identity approval. Images show thumbnails, PDF/images support preview, and download is explicit. Received is distinguished from Download started; browser download initiation is not proof of disk completion. Leaving/changing desks warns about received files that have not had a download requested. New document contents and visitor credentials are not persisted. Connection activity lights are separate from Sending/Receiving/Received/Interrupted file status. Student file controls are simplified; technical diagnostics are under Having trouble? and staff file history remains exportable.

Admins use Manage physical desks to update a location or reassign to an active employee email. If both employees already have desks, their assignments are swapped atomically, both active work sessions close, and both physical QR codes remain unchanged. **Replace printed QR** closes the desk and invalidates its old code; staff refresh and print the replacement. Only administrators can perform these operations.

## Phone PDF preview

PDFs render locally with the bundled Mozilla PDF.js library rather than relying on a native phone PDF viewer. Use Previous page / Next page in the preview. Rendering is temporary and bounded to one page; download a file to keep it. See docs/PROJECT-HANDOFF.md for the current direction tabs and student entry flow.
