# Document Exchange

A private document handover between a university desk and approved students. The browser attempts a direct WebRTC connection; ordinary HTTPS is always available as a fallback. No paid TURN service, database, domain or subscription is required.

## Use it

Staff open the website, enter a desk name and the private desk access key, then share the generated QR code. Students open that invitation and enter a name or student ID. Staff approve each connection and can send documents back to that student.

Keep both pages open until **Received ✓** appears. That receipt means the receiving browser verified and saved the entire document. It does not mean the person downloaded a permanent copy or read it. Use **Save a copy** before removing a file, clearing browser data, or using a shared computer.

Refresh the same browser to resume a session or recover saved files. Temporarily interrupted transfers retry without restarting from the beginning. Original outgoing documents remain saved for manual resending when a session expires. **Send again** starts a new transfer; it is not a continuation across expired sessions.

## Run locally

Use Node.js 24 or newer and install dependencies with `npm ci`. Create an untracked `.dev.vars` file containing `DESK_SETUP_KEY=your-random-secret-of-at-least-16-characters`. Use a cryptographically random secret, not an ordinary password. Run `npm run dev`, then open the localhost address printed by Wrangler. Web Crypto requires HTTPS or localhost.

Run `npm run check` and `npm test`. For actual browser tests, run `npx playwright install chromium`, start the development server, then run `npm run test:browser`. The test also accepts `CHROME_PATH` for an installed Chrome executable, `TEST_URL` for a deployed service, and `DESK_SETUP_KEY` for its test access key. Tests create and end their own desk sessions.

The browser test checks both directions, real direct-channel negotiation followed by a deliberate mid-transfer channel failure, HTTPS with WebRTC disabled, refresh recovery, a network interruption, a lost acknowledgement, exact file bytes, and document retention after ending a session. The student page uses a phone-sized viewport. It is not a test on the university's actual network or on an actual phone.

## Deploy for free

1. Use a Cloudflare account on **Workers Free**. Do not upgrade its plan or add a paid TURN provider. This repository binds only static assets and a SQLite Durable Object, which are available on Free.
2. Replace `account_id` in `wrangler.jsonc` if deploying to another account. Run `npx wrangler login`, then `npm run deploy`. On first deployment, register a free `workers.dev` subdomain when prompted.
3. Set the production access secret with `npx wrangler secret put DESK_SETUP_KEY`. Enter the secret when prompted. `.dev.vars` is local-only and is not uploaded automatically.
4. Open the deployed HTTPS address. Keep the staff secret private; it must never be included in a student invitation, a public repository, or browser diagnostics.

Static assets are committed, including the QR library. `npm run build:qr` rebuilds that bundle after updating its dependency. No external JavaScript/CSS CDN is needed. Wrangler deploys `public/`; the original root `index.html` belongs to the retired public-signaling version and is not used by this service. Existing GitHub Pages hosting cannot run the new server: share the new Worker address after rollout.

## What recovery does

The sender first saves its original file in IndexedDB. A recipient reserves device storage before accepting. Each 512 KiB chunk is encrypted with AES-GCM using a peer-to-peer ECDH key, including the file identity and chunk position as authenticated data. A direct data-channel chunk gets a brief opportunity to arrive; otherwise the sender uploads that same encrypted chunk over HTTPS.

The recipient verifies and commits a chunk to IndexedDB **before** acknowledging it. Acknowledgements are monotonic and retryable. Once every chunk has been acknowledged, the recipient assembles the file and commits it durably before sending the final receipt. The relay then deletes buffered ciphertext. A refresh reloads the saved private key, original file and chunk offset. Cloudflare stores connection metadata and limited encrypted chunks; it does not receive plaintext document bytes or browser private keys.

The QR fragment pins the desk public-key fingerprint and contains an invitation secret, not the staff's owner token. Server-side approval gates file and signaling endpoints. Typed student IDs are labels, **not verified university identities**. Staff should check the person before approving. Invitation holders can request a connection until the desk session ends; there is no public room discovery.

## Bounds and limitations

- PDF, DOCX, PNG and JPEG only. 150 MiB per file; 300 MiB reserved document storage per browser. Actual browser storage may be smaller. Storage errors stop acknowledgements instead of discarding the original.
- Up to 10 desks, 20 student connections per desk, and 100 transfers per desk session. Sessions expire after 8 hours. There is one bounded server hub for this small deployment, not an unlimited public file-sharing platform.
- A global 32 MiB relay buffer and a four-chunk server window bound remote storage. Expired metadata and chunks are cleaned up by an alarm. Idle browser polling is every 15 seconds; transfer polling is faster and slows when progress stops. Failed requests back off to 30 seconds. Direct negotiation is capped at three attempts per peer/page load; HTTPS remains usable afterwards. Leave old pages/session tabs closed when unused.
- Workers Free currently allows 100,000 requests/day across the account. Durable Objects Free has its own request, execution, storage and SQL read/write quotas. If any quota is exhausted, the service can stop until the quota resets. This project does not purchase additional capacity. Other projects on the same account share quotas. Check usage during the university pilot.
- Both devices must be online within the session. Sleeping phones, closed tabs, browser eviction, device failure, or manually clearing site data can prevent continuation. Save completed documents to permanent storage. IndexedDB is not a backup service.
- A blocked UDP route or restricted NAT does not prevent the HTTPS path. If IT blocks the Worker HTTPS address, or the whole network is offline, application code cannot guarantee a connection. Check that the same origin's `/api/health` and authenticated room requests succeed from the campus desk. An IT-approved address is the dependable solution if that address is blocked.
- Preview is restricted to PDF/images; PDF frames are sandboxed. DOCX is download-only and checked as a ZIP container. This is not an antivirus or a document-content scanner. Treat documents received from unknown people accordingly.
- Names, filenames, sizes and connection metadata are visible to the host. End-to-end encryption protects document contents against passive relay access; a compromised site serving malicious JavaScript remains a threat.

Cloudflare documentation: [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/). Verify these before changing deployment scale or plan.

## Source layout

- `public/app.js`, `index.html`, `style.css`: sender/desk interface and session lifecycle.
- `public/transfer.js`: persisted transfer queue, retry, acknowledgements and receipt.
- `public/direct.js`: optional direct data channel and authenticated negotiation.
- `public/storage.js`, `crypto.js`, `protocol.js`: browser storage, encryption and shared validation.
- `server/worker.js`: same-origin API, desk ownership, approval, relay, quotas and expiry.
- `tests/`: security/protocol checks and real browser recovery tests.

The old page used third-party public signaling and client-side role messages. The new service changes its protocol and cannot connect to an old page. Existing saved data in the old application's storage is not migrated or deleted; download any needed documents from the old page before switching.
