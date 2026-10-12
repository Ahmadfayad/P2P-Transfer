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

## Local development

Install dependencies with `npm ci`. Create an ignored `.dev.vars` using the existing authorized account credentials: `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL=http://127.0.0.1:8788`. Obtain secrets privately from the existing deployment; do not paste them into ChatGPT project files. Run `npx wrangler dev --port 8788`.

Run `npm run check`, `npm test` and the browser scripts in `tests/`. Browser tests need the local server, Chrome and privately provided admin credentials. Browser fixtures create and remove only their own test accounts. Never run an unreviewed schema reset against production.
