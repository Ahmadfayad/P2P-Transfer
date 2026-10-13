# Current desk workflow

The permanent printed-desk update supersedes the earlier ten-minute whole-room behavior described in the historical sections below. Staff desks are work sessions up to eight hours; students expire independently after ten minutes, with a maximum two-minute accepted-transfer grace and a staff extension action. QR codes remain fixed across sessions and staff reassignment. See the permanent-desk section in README.md for operation.

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

New document bytes never enter server SQLite, browser IndexedDB, Cache Storage or localStorage. Selected originals are read in slices from their existing user file; new receives load automatically into bounded temporary browser memory for preview/download. New transfer-session keys/credentials and invitation fragments stay only in page memory; existing legacy saved files and their account-isolated records are retained. Employee login remains managed by Better Auth. Schema additions preserve existing tables and bytes; persistent upload endpoints reject new writes, while saved-file recovery and legacy reads remain available. New rooms expire after ten minutes; older room expiry and legacy storage are retained; deployment does not reset storage.

Business records contain student name, optional email/student ID and filename, plus required identifiers, byte size, key/credential security metadata, approval, expiry and transfer/save status. Logs contain none of the business details, document contents, filenames, passwords, tokens, invitation secrets or encryption keys. Arbitrary error messages are omitted from diagnostic records in favor of error classes.

- Received: every frame authenticated, correct order/length and stream end verified.
- Download initiated: the browser was asked to download; disk completion is not observable.
- Saved to disk: retained legacy receipts from the former native disk receive flow; automatic downloads do not claim this status.

Automatic receive cannot open a disk picker requiring a user gesture. Staff and students receive and verify into temporary memory without a per-file prompt, then preview/download. The existing 150 MiB file limit is supported within a 300 MiB reserved receive budget per page; full buffers fail clearly with a resend instruction. Downloaded files remain on the PC; received-only blobs disappear on refresh/close. Browser download initiation does not confirm disk completion.

## Free-plan bounds

- Existing Cloudflare Worker and SQLite Durable Object; existing Vercel uos-file-transfer preview only. No paid service, new project, TURN subscription or new runtime dependency. The inherited Metered pilot is explicitly disabled; its metadata/secrets are left intact but unused.
- At most four simultaneous HTTPS streams, four receive operations per browser, 100 metadata waiters, and existing limits of ten desks, twenty peers per desk and one hundred transfer records per room.
- About 4 MiB per sender upload window; 64 KiB relay writes with backpressure; one decrypted frame at a time added to bounded receive parts. Direct flow uses four frames in flight and a bounded inbox.
- Temporary-download receivers reserve at most 300 MiB of plaintext across pending/completed receives; Blob assembly can briefly retain another bounded copy. Remove temporary downloads after saving to release the budget.
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

Browser checks cover exact received bytes in both directions without manual acceptance, image thumbnails/preview, temporary downloads, direct-to-HTTPS fallback, slowed decryption, refresh without session restoration, staff/account revocation, no new session/file/chunk IndexedDB records, diagnostic redaction, legacy recovery/isolation, account administration and safe legacy previews. Browser-clock checks and server checks enforce the ten-minute deadline. Historical native-disk test-double results below describe the former manual receive flow.

Campus Ethernet/Wi-Fi versus actual mobile data, iOS Safari/Android phones, external proxies buffering uploads, large sustained transfers and multiple seated staff have not been measured. These local results do not predict a guaranteed campus speed or uninterrupted connection. Collect both sides' sanitized system logs during the pilot and use the existing Cloudflare URL first.

## Initial hosted streaming verification, 13 October 2026 (historical)

The integrated implementation was committed as `e3a6561` and deployed to the existing Cloudflare Worker. Deployment version: `05719173-ba4f-49d0-a26a-766addb9857f`. That build reports protocol 4 and app version `stream-v1`. The existing uos-file-transfer preview is Ready; main and Vercel production were not promoted.

An exact-byte 8 MiB hosted transfer, approval, temporary-storage and diagnostic-redaction check passed from this PC in Chrome (7.370 s), Firefox (11.222 s) and WebKit (9.601 s). These hosted samples use the external Cloudflare path and must not be compared directly to local Wrangler samples. They are not campus/mobile-data measurements. Temporary accounts and desks were removed after the checks. Native save operations still used an API test double; a real campus PC save-dialog pilot remains required.

The rebased suite has 25 passing unit/security tests, including retained visitor capacity/withdrawal and native connection safety checks. The credential-free CI loopback suite, actual local Wrangler browser suite, real-account regressions and native Miniflare socket/build checks passed. No GitHub-hosted workflow result was confirmed during this session.

## Automatic receive verification, 13 October 2026

The current flow no longer prompts Receive & save. The original campus/mobile log pair had an offered 646,474-byte file and next=0, with successful HTTPS calls and no accept/stream request: it was blocked by the former manual gate.

The credential-free loopback Chrome suite verifies exact bytes, both directions, direct-to-HTTPS fallback, interruption/revocation, no restored sessions, diagnostic redaction and both ten-minute browser deadlines. The 8 MiB samples were 3.267 s HTTPS (33 API requests, two upload windows) and 5.383 s forced direct-to-HTTPS (33 requests). These are local loopback samples, not measured campus performance. The real local Worker/Neon automatic HTTPS sample was 4.431 s. Earlier native disk and manual receive measurements remain historical.

Final pre-deployment validation: 27 unit/security tests; credential-free loopback full suite; actual local Worker/Neon Chrome full suite; Firefox and WebKit automatic receipt/preview/download compatibility; employee/admin/password/role/legacy-file regressions; updated refresh/role isolation checks; and native Worker/Miniflare authorization/socket/build checks passed. The latest real local Chrome sample was 4.728 s HTTPS / 5.251 s forced direct-to-HTTPS. Firefox and WebKit samples were 6.182 s and 6.735 s while other checks ran concurrently. These are local results, not campus speed guarantees. New diagnostic exports and API headers identify the build as auto-receive-v1.

## Current automatic-receive deployment

Code commit: `99b38dee4f26d0f14bfb45cf0b0de7750692206b`. Existing Cloudflare Worker version: `a492bae4-7436-488c-a2bd-2806cea50470`; health reports protocol 4 and `X-App-Version: auto-receive-v1`. Hosted Chrome, Firefox and WebKit checks passed for exact bytes in both directions, automatic image thumbnails/preview, downloads, diagnostic redaction, presence, desk switching and refresh without session restoration. The 8 MiB hosted HTTPS samples were 8.885 s, 9.520 s and 13.944 s respectively from the personal PC while tests ran concurrently. These are not campus measurements or a controlled browser speed comparison.

The existing `uos-file-transfer` Vercel preview is Ready at https://uos-file-transfer-git-reliable-transfer-ahmadfayads-projects.vercel.app (verified deployment dpl_DQQeZnwfRF7wBD4PKpzG9frXKi1D, target preview). Main/Vercel production remain unpromoted. The draft PR is #2. GitHub-hosted workflow results were unavailable; the corresponding local checks passed. Old saved documents/storage were not reset. Refresh the staff page and open a fresh ten-minute desk QR invitation before the next campus trial. Download received files before closing or refreshing.

## Permanent printed desks and simpler handover

Each physical desk has a persistent invitation ID/code and an assigned employee. Initially an employee is provisioned one desk; set its number/location and use **Print desk QR**. The print sheet uses the physical location, not the employee name, so staff reassignment does not require changing the printed QR. QR contents stay the same across closing, reopening and signing in. Transfer public keys and private owner credentials are fresh on each opening. A printed invitation alone never approves a student or grants file access.

Students scan with their phone camera; before requesting approval they see the staff name and desk location. Closed desks display an unavailable message and a Check desk again button. **Change desk** ends the local connection immediately and asks the student to scan the physical QR at their next seat. There is no URL input. Network failure does not trap them in the previous desk. Name and student ID are separate required fields; email is not requested.

Staff work sessions stay open up to eight hours and close on explicit ending, sign-out, password change, disablement or reassignment. Visitors receive their own ten-minute deadline. A countdown warns during the last minute; staff can Extend 10 minutes for an approved visitor. After the normal deadline no new offers are allowed. An already accepted transfer may finish for at most two extra minutes, then the visitor must scan again. Staff can end one visitor without ending other visitors or the desk. These rules are checked on the server as well as in the interface.

Files arrive automatically after one identity approval. Images show thumbnails, PDF/images support preview, and download is explicit. Received is distinguished from Download started; browser download initiation is not proof of disk completion. Leaving/changing desks warns about received files that have not had a download requested. New document contents and visitor credentials are not persisted. Connection activity lights are separate from Sending/Receiving/Received/Interrupted file status. Student file controls are simplified; technical diagnostics are under Having trouble? and staff file history remains exportable.

Admins use Manage physical desks to update a location or reassign to an active employee email. If both employees already have desks, their assignments are swapped atomically, both active work sessions close, and both physical QR codes remain unchanged. **Replace printed QR** closes the desk and invalidates its old code; staff refresh and print the replacement. Only administrators can perform these operations.

Implementation: additive SQLite desks table plus peers.expires; no storage reset or paid dependency. Desk resolution returns only public staff/location and currently available invitation/public-key metadata. Private owner tokens are never returned publicly. Stable printed invitation codes are public entry credentials protected by staff approval; they are not encryption keys or account credentials. Diagnostic route templates exclude desk IDs/codes and business details. The new build identifies as printed-desks-v1.

Validation: 29 unit/security checks including fixed QR reopening/replacement/ownership, physical reassignment and swap, logout closure, independent expiry, staff-only extension, grace, no offers after the normal deadline, stream integrity/redaction/storage bounds; real Worker/Neon account/admin/role/legacy-preview checks; full Chrome transfer/revocation/refresh/expiry checks; Firefox/WebKit mobile and exact-byte transfers; and printed sheet/admin-flow browser checks. Existing saved documents and legacy storage remain intact. Local final 8 MiB samples with concurrent tests: Chrome 5.452 s HTTPS / 5.378 s direct-to-HTTPS, Firefox 5.543 s, WebKit 5.525 s. These are local measurements, not campus guarantees. Physical printing/scanning and new campus/mobile-data behavior still require a real-device pilot.

## Live permanent-desk release

The fixed physical-desk workflow is live on the existing Cloudflare service. Final code commit: `a7e34805f5ffb9f8060812679c513a2837ee0c87`; Worker version `57f86814-e8ca-4bc5-a83d-0d72efc3271b`; health 200, protocol 4 / printed-desks-v1. Printed invitations always use the primary Cloudflare address, including when staff visit a Vercel preview, so their content stays fixed across frontend addresses. Localhost testing remains local.

Hosted exact-byte transfers, reverse transfers, previews/downloads, redaction, mobile layout and physical desk switching passed in Chrome, Firefox and WebKit. Concurrent 8 MiB samples from the personal PC were 13.553 s, 9.695 s and 11.963 s respectively; these are not campus measurements. The hosted complete print/closed/open/reopen/logout/admin-reassignment/swap/replacement checks passed, including the final canonical-address release. Temporary test accounts and closed test desks were cleaned up; normal employee accounts were unchanged. The existing uos-file-transfer preview is Ready; main and Vercel production remain unpromoted. GitHub-hosted workflow results were unavailable, while local checks passed.

Next campus step: refresh the staff page, enter the physical desk location, choose Print desk QR once and place it at the desk. Reuse that sheet whenever the desk opens. The QR does not approve students automatically. Keep pages visible during transfer and download received files before refresh/close. A real paper scan and campus/mobile-background pilot remain unverified.
