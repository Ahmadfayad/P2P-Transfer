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

Files are encrypted in the browser using P-256 ECDH and AES-GCM. WebRTC is optional; HTTPS encrypted chunks remain available when campus networking blocks direct connections. Verified files and transfer progress are retained in IndexedDB for recovery. Browser storage belongs to that device; GitHub does not contain transferred documents.

`public/` contains the interface and transfer client; `server/worker.js` contains the API and SQLite Durable Object relay; `server/auth.js` uses Better Auth and Neon Postgres for employee authentication. Cloudflare hosts the server; Vercel hosts a static preview with a rewrite to Cloudflare. Analytics is enabled on the existing Vercel project. No paid dependency was added.

Use **Connection help & system log → Download system log** on the affected browser. Select the network type first. Ask staff to export their log too. Logs include bounded recent requests, errors, timing, connection events and transfer progress; staff logs also include recent server records. They exclude passwords, tokens, invitation fragments and document contents. They cannot reveal the campus firewall's internal rules.

## Campus pilot, 12 October 2026

Four sanitized exports from the university Ethernet desk and a mobile-data guest show successful sign-in, joining and approval. The roughly 3 MB transfer was still incomplete at the last export. Ordinary room requests took about 0.5-0.6 seconds; guest chunk uploads took about 1.8-2.4 seconds. The old client sent one chunk per acknowledgement and uploaded some stored chunks again. WebRTC connected briefly, then failed while its data channel still reported open. A 20-second request timeout occurred while the phone browser was hidden. These records do not establish a specific firewall rule or explain the background timeout.

The client now fills the existing four-chunk window concurrently, avoids duplicate stored uploads and drains the receiver window with ordered persisted acknowledgements. Optional signaling does not hold up HTTPS, and unacknowledged direct packets disable direct sending for that connection. No database migration, account-cache bypass, buffer-limit increase or paid service is involved. Regression checks cover four concurrent uploads, stalled direct packets, refresh/lost-ACK recovery with exact 3 MB bytes and the student/staff approval UI. Faster campus transfer times still require a new on-site test, with both browsers kept visible initially.

## Local development

Install dependencies with `npm ci`. Create an ignored `.dev.vars` using the existing authorized account credentials: `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL=http://127.0.0.1:8788`. Obtain secrets privately from the existing deployment; do not paste them into ChatGPT project files. Run `npx wrangler dev --port 8788`.

Run `npm run check`, `npm test` and the browser scripts in `tests/`. Browser tests need the local server, Chrome and privately provided admin credentials. Browser fixtures create and remove only their own test accounts. Never run an unreviewed schema reset against production.
