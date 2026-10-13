# Continue Document Exchange on another computer

This is the P2P-Transfer repository. The working branch is `reliable-transfer` and the review is https://github.com/Ahmadfayad/P2P-Transfer/pull/2.

The live Cloudflare service runs independently of the personal PC:
https://uos-document-exchange.uos-document-exchange.workers.dev

The existing Vercel project is **uos-file-transfer**. Its review preview is:
https://uos-file-transfer-git-reliable-transfer-ahmadfayads-projects.vercel.app
The production Vercel site is still the original main branch until promotion is requested.

## Work PC

Sign into the same ChatGPT account and workspace. A local project points to a folder on one computer; conversation sync does not copy that folder to another computer. Download or clone `reliable-transfer` from GitHub on the work PC, then add the downloaded folder as a local project in the desktop app. If you prefer a ChatGPT web Project, upload this handoff and the source ZIP as project reference files. Never upload credentials or `.dev.vars`.

Official explanation: https://learn.chatgpt.com/docs/projects

## App behavior

Only employees have accounts: Staff open a seated desk, approve visitors and exchange documents; Admin also manages employees, roles and CSV imports. Passwords are at least six characters. Students scan a desk's unique QR invitation and enter a name/ID without signing in. Their identity label is self-reported, so staff must check it before approving.

Files are encrypted in the browser using P-256 ECDH and AES-GCM. WebRTC is optional; HTTPS encrypted chunks remain available when campus networking blocks direct connections. New document contents are streamed temporarily and are not saved in SQLite or IndexedDB. Existing earlier saved documents remain untouched. Incoming files now load automatically into bounded temporary memory (150 MiB/file, 300 MiB total per page), with preview/download. No disk picker blocks receipt. Refresh requires a new QR connection and resending unfinished transfers. Browser storage belongs to that device; GitHub does not contain transferred documents.

`public/` contains the interface and transfer client; `server/worker.js` contains the API and SQLite Durable Object relay; `server/auth.js` uses Better Auth and Neon Postgres for employee authentication. Cloudflare hosts the server; Vercel hosts a static preview with a rewrite to Cloudflare. Analytics is enabled on the existing Vercel project. No paid dependency was added. Read docs/STREAMING.md for transport choices, privacy, free limits and measured verification.

Use **Connection help & system log → Download system log** on the affected browser. Select the network type first. Ask staff to export their log too. Logs include bounded recent requests, errors, timing, connection events and transfer progress; staff logs also include recent server records. They exclude passwords, tokens, invitation fragments and document contents. They cannot reveal the campus firewall's internal rules.

## Campus pilot, 12 October 2026

Four sanitized exports from the university Ethernet desk and a mobile-data guest show successful sign-in, joining and approval. The roughly 3 MB transfer was still incomplete at the last export. Ordinary room requests took about 0.5-0.6 seconds; guest chunk uploads took about 1.8-2.4 seconds. The old client sent one chunk per acknowledgement and uploaded some stored chunks again. WebRTC connected briefly, then failed while its data channel still reported open. A 20-second request timeout occurred while the phone browser was hidden. These records do not establish a specific firewall rule or explain the background timeout.

The client now fills the existing four-chunk window concurrently, avoids duplicate stored uploads and drains the receiver window with ordered persisted acknowledgements. Optional signaling does not hold up HTTPS, and unacknowledged direct packets disable direct sending for that connection. No database migration, account-cache bypass, buffer-limit increase or paid service is involved. Regression checks cover four concurrent uploads, stalled direct packets, refresh/lost-ACK recovery with exact 3 MB bytes and the student/staff approval UI. Faster campus transfer times still require a new on-site test, with both browsers kept visible initially.

## Waiting and connection display

The student gate includes a rotating checking/waiting indicator with reduced-motion support. Staff see only pending/approved visitors in the main list; ended requests are grouped by entered name/ID in a collapsed section. Matching a past entered label shows a returning notice in the approval popup; matching an active label warns about another connection. Neither match grants approval or merges peer/file ownership. A previously observed inactive peer with a fresh heartbeat is marked as reconnected until this staff page or desk session resets. Heartbeat inactivity is not proof of a disconnected network.

Historical note (superseded by the streaming update): the transport pilot added authenticated, hibernating WebSocket wake hints, event-driven transfer ticks and saved acknowledgements in batches of up to four. HTTP still authenticates state and transfer operations; WebSockets cannot perform file or approval operations. There is an additive `turn_transfers` metadata table and a conservative monthly pilot reservation, with no namespace change or existing-data reset. TURN remains disabled until a private expiring Open Relay credential is configured. See [TURN-PILOT.md](TURN-PILOT.md) and the masked local `scripts/configure-turn-pilot.ps1` helper. The provider must remain on its bounded Free plan; actual TURN routing, speed, phone background behavior and campus WebSocket access need a new pilot. This is not a Cloudflare migration.

## Local development

Install dependencies with `npm ci`. Create an ignored `.dev.vars` using the existing authorized account credentials: `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL=http://127.0.0.1:8788`. Obtain secrets privately from the existing deployment; do not paste them into ChatGPT project files. Run `npx wrangler dev --port 8788`.

Run `npm run check`, `npm test` and the browser scripts in `tests/`. Browser tests need the local server, installed browser engines and private local database authentication. They create their own temporary employee/admin accounts. Browser fixtures create and remove only their own test accounts. Never run an unreviewed schema reset against production.

## Streaming update, 13 October 2026

The current stream protocol replaces document persistence and chunk retrieval with temporary encrypted streams. The existing student checking/waiting gate, staff approval popup, returning-visitor display and log sanitization are preserved. HTTP long polling supplies immediate notifications without requiring WebSockets. Metered/Open Relay is explicitly disabled; existing pilot secrets and metadata are retained but unused. See STREAMING.md for measurements and limitations.

Initial streaming deployment (superseded by the automatic handover update below): the streaming build was deployed at the existing Cloudflare URL. Deployment version: `05719173-ba4f-49d0-a26a-766addb9857f`; protocol 4 / app version `stream-v1`. Hosted exact-byte checks passed in Chrome, Firefox and WebKit from the personal PC. Their 8 MiB timings were 7.370 s, 11.222 s and 9.601 s respectively; campus/mobile-data behavior remains unverified. See STREAMING.md for the local latest-branch comparison (about 9.0 s before versus 4.5 s streaming), browser limits and historical manual save-dialog pilot.

## Automatic handover update, 13 October 2026

The supplied campus/mobile logs show a 646,474-byte offer with next=0 and no accept/stream request. Successful HTTPS state/approval calls and no reported failures identify the manual Receive & save gate as the immediate cause of this waiting state; the records do not prove a campus firewall block.

Both receivers now accept offers automatically after staff approval. Files are verified before preview/download; image thumbnails load automatically. No new content, session secrets, keys or invitation fragments are written to IndexedDB/localStorage/sessionStorage. Earlier saved files and legacy session records remain intact. New rooms expire after ten minutes; both browser timers and server authorization enforce this. Employee login continues independently. Refresh does not restore a transfer session.

Desk names use the authenticated employee profile on both client and server; a supplied desk name cannot override the trusted profile header. The authorized existing profile display name is Ahmad Albalbissi, with password and role unchanged. Students see the staff name and can Change desk to withdraw their old peer, then scan/paste a new invitation. Presence lights use authenticated heartbeat age: green through 40 seconds, amber after 40 or while pending/retrying, red after 70 seconds, on stopped service or ended connection. Background browsers and throttled networks can make activity uncertain; ICE failure alone does not mean HTTPS is disconnected.

Final pre-deployment validation: 27 unit/security tests; credential-free loopback full suite; actual local Worker/Neon Chrome full suite; Firefox and WebKit automatic receipt/preview/download compatibility; employee/admin/password/role/legacy-file regressions; updated refresh/role isolation checks; and native Worker/Miniflare authorization/socket/build checks passed. The latest real local Chrome sample was 4.728 s HTTPS / 5.251 s forced direct-to-HTTPS. Firefox and WebKit samples were 6.182 s and 6.735 s while other checks ran concurrently. These are local results, not campus speed guarantees. New diagnostic exports and API headers identify the build as auto-receive-v1.

## Current automatic-receive deployment

Code commit: `99b38dee4f26d0f14bfb45cf0b0de7750692206b`. Existing Cloudflare Worker version: `a492bae4-7436-488c-a2bd-2806cea50470`; health reports protocol 4 and `X-App-Version: auto-receive-v1`. Hosted Chrome, Firefox and WebKit checks passed for exact bytes in both directions, automatic image thumbnails/preview, downloads, diagnostic redaction, presence, desk switching and refresh without session restoration. The 8 MiB hosted HTTPS samples were 8.885 s, 9.520 s and 13.944 s respectively from the personal PC while tests ran concurrently. These are not campus measurements or a controlled browser speed comparison.

The existing `uos-file-transfer` Vercel preview is Ready at https://uos-file-transfer-git-reliable-transfer-ahmadfayads-projects.vercel.app (verified deployment dpl_DQQeZnwfRF7wBD4PKpzG9frXKi1D, target preview). Main/Vercel production remain unpromoted. The draft PR is #2. GitHub-hosted workflow results were unavailable; the corresponding local checks passed. Old saved documents/storage were not reset. Refresh the staff page and open a fresh ten-minute desk QR invitation before the next campus trial. Download received files before closing or refreshing.
