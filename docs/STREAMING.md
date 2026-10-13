# Encrypted streaming: implementation and verification

## Transport choice

The original relay sent one 512 KiB chunk per acknowledgement and polled state. The newer remote commits pipelined four chunks and added wake hints, but still uploaded/retrieved chunks through authenticated HTTP, wrote ciphertext to SQLite and wrote verified plaintext to IndexedDB. Staff requests frequently traversed Neon. The stream update is rebased on those commits and preserves their approval UI, connection-history display and strict log sanitization.

The new protocol uses a continuous authenticated HTTPS GET for the receiver and POST upload windows containing eight independently encrypted 512 KiB frames, about 4 MiB. The relay forwards each body through a backpressured stream in 64 KiB writes without collecting a document or writing document bytes to SQLite. A window response waits for downstream stream consumption. There is no repeated GET retrieval of document chunks.

This follows [Piping Server's POST-to-GET streaming model](https://github.com/nwtgck/piping-server), without adopting its unauthenticated paths or Node HTTP server. Piping Server is not a drop-in Cloudflare Durable Object library. The application keeps its room ownership, invitations, approval, AES-GCM integrity and private browser keys.

A single unlimited browser upload stream is deliberately not assumed. [Chromium's request streams require HTTP/2 or HTTP/3 and have proxy/browser restrictions](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests). [Cloudflare Free limits a request body to 100 MB](https://developers.cloudflare.com/workers/platform/limits/), below this application's 150 MiB document limit. Standard bounded Blob POST bodies work in the tested Chrome, Firefox and WebKit engines, and each window stays well below the provider body limit. This is a streaming receive relay with windowed uploads, not one unbounded POST.

WebRTC remains optional. It pipelines up to four encrypted frames using data-channel credit acknowledgements instead of per-frame database writes. If the data channel stalls or closes, the receiver opens HTTPS at its verified in-memory offset and the sender continues from that offset. A page refresh or runtime eviction does not retain that buffer: it explicitly requires a resend.

## Authorization, status and storage

Employee login and roles still use Neon-backed Better Auth. Only an authenticated room owner can mint a random room-scoped employee lease. It lasts 90 seconds and is renewed on normal control cycles, reducing repeated Neon checks during data transfer. Both the private room token and the lease are required; forged account headers and copied owner tokens without the lease cannot act as the employee. App sign-out, role/password changes and disabling an employee revoke leases, reject unfinished transfers and abort the relay. Changes performed outside this app are bounded by lease expiry/renewal.

Guest students use their private peer token, an expiring QR invitation and staff approval. They cannot approve themselves, act as a desk or access another student's stream. Metadata changes wake a bounded 20-second long poll, so file offers and approval updates do not wait for an idle polling timer. Long polls recheck expiry and employee authorization before returning.

New document bytes never enter server SQLite, browser IndexedDB, Cache Storage or localStorage. Selected originals are read in slices from their existing user file; native receives write to a user-selected PC file. Browser session keys/credentials and existing legacy saved files stay in their original account-isolated stores. Schema additions preserve existing tables and bytes; persistent upload endpoints reject new writes, while saved-file recovery and legacy reads remain available. The original expiry/cleanup policy continues; deployment does not reset storage.

Business records contain student name, optional email/student ID and filename, plus required identifiers, byte size, key/credential security metadata, approval, expiry and transfer/save status. Logs contain none of the business details, document contents, filenames, passwords, tokens, invitation secrets or encryption keys. Arbitrary error messages are omitted from diagnostic records in favor of error classes.

- Received: every frame authenticated, correct order/length and stream end verified.
- Download initiated: the browser was asked to download; disk completion is not observable.
- Saved to disk: a native File System Access writable closed successfully after verification.

[showSaveFilePicker requires a user gesture and is not available in every browser](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker). Staff click Receive & save before transfer. Desktop Chrome/Edge can write directly to disk; unsupported receivers have a 16 MiB total temporary-download budget. Incomplete native writes are aborted. Browser-API close confirms the write operation, not a claim about physical drive durability.

## Free-plan bounds

- Existing Cloudflare Worker and SQLite Durable Object; existing Vercel uos-file-transfer preview only. No paid service, new project, TURN subscription or new runtime dependency. The inherited Metered pilot is explicitly disabled; its metadata/secrets are left intact but unused.
- At most four simultaneous HTTPS streams, four receive operations per browser, 100 metadata waiters, and existing limits of ten desks, twenty peers per desk and one hundred transfer records per room.
- About 4 MiB per sender upload window; 64 KiB relay writes with backpressure; one decrypted frame at a time for disk receives. Direct flow uses four frames in flight and a bounded inbox.
- Temporary-download receivers reserve at most 16 MiB of plaintext across pending/completed receives; Blob assembly can briefly retain another bounded copy. Remove temporary downloads after saving to release the budget.
- Stall/inactivity timeout: 45 seconds. Upload request deadline: 120 seconds per window. No whole-document SQL writes or per-frame IndexedDB writes.
- Existing free quotas still apply: [Workers request/CPU/memory limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects daily requests/duration/storage limits](https://developers.cloudflare.com/durable-objects/platform/pricing/). No paid upgrade or plan change was made. One shared object caps memory; the app cannot guarantee service after a provider quota or domain block.

## Measured local results

Windows desktop, real headless Chrome, local Wrangler worker and the existing remote Neon account database. Both versions used an 8 MiB PDF-shaped payload with WebRTC disabled and identical SHA-256 verified after a browser download. Timing starts at file selection, includes file-offer/accept handling and ends after verified receipt/download. Both pre-streaming committed baselines were run in separate local folders/databases, without modifying or deleting existing storage. Numbers below are individual samples, not a statistical benchmark.

| Path                                       |     Time | API requests | Content upload requests |
| ------------------------------------------ | -------: | -----------: | ----------------------: |
| Initial baseline, commit 6f1dabe           | 20.276 s |          138 |           16 chunk PUTs |
| Latest pre-stream baseline, commit 2e3f761 |  9.004 s |           75 |           16 chunk PUTs |
| New HTTPS streaming, Chrome                |  4.362 s |           32 |          2 window POSTs |
| New HTTPS streaming, Firefox               |  4.001 s |           32 |          2 window POSTs |
| New HTTPS streaming, WebKit                |  4.644 s |           29 |          2 window POSTs |
| Direct channel forcibly closed, then HTTPS |  5.210 s |           30 |          2 window POSTs |

The direct-fallback sample deliberately slowed the receiver's disk API test double by 80 ms per frame and closed the real negotiated data channel. It verifies fallback and exact bytes; it is not a normal direct-speed benchmark. Compatibility samples ran alongside other regressions and are not controlled comparisons between browser engines. Raw local reports are in ignored test-results/*-performance.json; they record the latest run and can differ slightly from earlier samples listed here.

## Verification and remaining pilot work

Unit/security checks cover frame integrity and altered AAD, private-token/lease ownership, forged headers, unauthorized recipients, rejection of persistent uploads, complete-receipt authorization, lease revocation, long-poll wake-up, preservation of old SQLite bytes, bounded concurrency, backpressure, truncated/oversized uploads and the actual 45-second stall timeout. Diagnostic tests reject business details and secrets.

Browser checks cover exact received bytes, temporary memory downloads, direct-to-HTTPS fallback, slow disk writes, refreshed pages requesting resend, rejected files, staff rejection aborting writes, disabled employee access, no new file/chunk IndexedDB records, diagnostic redaction, existing saved-file recovery/isolation, administration, six-character login, password/role controls and safe legacy document previews. Native disk operations are tested with an explicit API test double; an actual campus PC save-dialog pilot is still needed.

Campus Ethernet/Wi-Fi versus actual mobile data, iOS Safari/Android phones, external proxies buffering uploads, large sustained transfers and multiple seated staff have not been measured. These local results do not predict a guaranteed campus speed or uninterrupted connection. Collect both sides' sanitized system logs during the pilot and use the existing Cloudflare URL first.
