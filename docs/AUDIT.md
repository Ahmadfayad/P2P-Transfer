# P2P Transfer audit — 12 October 2026

Historical assessment of the original `index.html` at the commit listed below. The subsequent implementation, deployment, tests and remaining limits are documented in [README.md](../README.md); the findings here describe the original version, not the new deployed service.

**What this repo does:** A browser page lets a front desk create a desk room and QR link. Students join, enter a self-reported ID, request approval, and exchange files and chat using Trystero/WebRTC. Received documents remain in browser memory until downloaded; there is no application backend or durable receipt ledger.

Audited GitHub commit: `2fe23dea44b5ddce4ee27996dd0f3374e1d96248` (V2, 19 August 2026). The repository contains one tracked source file, `index.html`, and no test suite, dependency lockfile or deployment configuration. The workspace's original `index.html` is a different version; findings below refer to the downloaded GitHub version.

Assumed workload: one desk and a modest group of concurrent students. Testing at 5–20 concurrent visitors is a proposed validation target, not a measured capacity claim.

User's network evidence: the page loads on the desk's IT-configured university Ethernet/Wi-Fi, but connection sometimes remains pending. Senders using mobile data have fewer problems. IT cannot provide a server or an approved address. This points toward desk-side signaling/ICE restrictions, but does not establish the exact blocked protocol.

## How it works

1. Query parameters select student/desk mode. A sanitized desk ID determines the shared room name.
2. `joinRoom` connects through Trystero's signaling strategy. This exchanges connection information; it does not carry the application's file payloads.
3. WebRTC tries candidate network paths using STUN and configured TURN relays. STUN discovers addresses; TURN forwards encrypted WebRTC traffic when a direct path cannot be established.
4. The application exchanges `role`, `file`, `chat` and `ping` actions. Approval is application state keyed by a transient peer ID.
5. Trystero handles transport chunking/progress. The page receives a completed payload, creates a Blob URL, and shows Preview/Download.
6. Files, approval state, logs and pending selections are not durably preserved by the application. A page reload discards them.

The unversioned Trystero import prevents identifying one immutable dependency release from this repository. Current upstream documentation describes Nostr as its default strategy; older releases used other APIs/strategies. Pin and test the actual release instead of assuming a particular signaling network.

## Must fix

### 1. A room participant can impersonate the desk

**What this is:** Student-side role handling selects the receiver and enables uploads (`index.html:1490–1557`). Room access uses a predictable desk name and a public application ID (`334–369`).

**Problem:** Any connected room peer can announce `role: "receiver"`, replacing `receiverPeerId`. Approval/decline/sync messages are also accepted without checking that the sender is the authenticated desk. Reproductions confirmed both receiver replacement and approval by an unrelated peer. Separately, student IDs are typed labels, not verified identity.

**Fix:** Give the desk a private owner credential, issued/validated through a trusted HTTPS backend, and bind student sessions to that desk. Only accept control messages from the verified desk peer. Use random expiring invitations; a shared QR room password alone does not distinguish staff from students who know it.

**If we skip it:** Someone with room access can divert a student's documents to their own connection or disrupt approvals. WebRTC encryption protects the connection to that impersonator; it does not prove they are staff.

### 2. Received metadata can create an executable HTML preview

**What this is:** Received bytes become a Blob using the peer's claimed MIME type (`1194–1220`, `1693–1725`). Preview accepts every `text/*` MIME type in an unsandboxed iframe (`714–731`).

**Problem:** An approved custom client can send HTML bytes, claim `text/html`, and supply a harmless-looking filename. Opening Preview puts that document in an iframe with the application's Blob origin. The unsafe branch was reproduced; actual browser script execution was not tested.

**Fix:** Remove generic text/HTML iframe previews. Render plain text as text, validate allowed formats, and preview only trusted format paths. If sandboxing is used, test native PDF viewing: sandboxing can prevent the built-in viewer from loading. Never combine script and same-origin permissions for untrusted HTML.

**If we skip it:** Opening a malicious preview can expose the page's DOM, document links and browser storage to attacker code.

### 3. “Delivered” is not confirmed delivery

**What this is:** Sender success appears after `await fileAction.send` (`1624–1649`); return-document success works the same way (`1280–1299`).

**Problem:** There is no application receipt from the receiver after approval, validation and storage. A receiver can discard a completed file while the sender reports delivery. In addition, `createAction.send` catches synchronous exceptions and returns a fulfilled promise (`864–876`), which was reproduced with a failing transport stub.

**Fix:** Propagate send failures. Track separate Sending, Awaiting receipt and Received states. Return a receipt containing the stable transfer ID, byte count and integrity result only after the receiving application commits the file to its intended storage.

**If we skip it:** A student may leave believing a document was delivered when the desk does not have it. “Received in browser storage” must also remain distinct from “saved/downloaded by staff.”

### 4. Interrupted transfers have no application resume path

**What this is:** Each upload is one whole-file action with a new timestamp ID (`1589–1661`). Disconnect UI asks for a refresh (`1472–1487`).

**Problem:** There is no acknowledged chunk ledger, stable transfer identity across attempts, retry queue or persisted receiver progress. Transport-level reliable delivery and Trystero chunking do not provide application resume across a destroyed connection/reload.

**Fix:** Use stable UUIDs, numbered bounded chunks, an acknowledged-range ledger and deduplication. Reconnect automatically with bounded backoff; resume missing chunks across either WebRTC or HTTPS. Preserve pending data locally with an explicit retention limit, or ask the user to reselect the source file after reload.

**If we skip it:** Wi-Fi handovers, browser suspension or desk refreshes force a restart and can lose undownloaded received files.

### 5. TURN configuration is not a verified campus fallback

**What this is:** Three TURN URLs use the same provider hostname and public static credentials (`342–369`).

**Problem:** The `turn:` entries on ports 80/443 omit `transport=tcp`, so they do not explicitly request TCP. There is a correct TLS/TCP entry, but its credentials/endpoints were not connectivity-tested. Current Open Relay documentation advertises account/API-issued credentials and a 20 GB/month free allowance; it does not establish these legacy credentials still work. Three ports on one hostname are not three independent providers.

**Fix:** Obtain supported credentials, test for relay candidates from campus, then force relay-only in a diagnostic build to prove an actual two-browser transfer. Keep API secrets server-side and issue short-lived credentials. Do not infer success merely because STUN produces candidates.

**If we skip it:** The app may work on permissive home/mobile networks while failing wherever a working relay is necessary. Signaling redundancy does not repair blocked file transport.

### 6. File acceptance and identity checks happen too late

**What this is:** The normal send UI enforces extensions and 150 MiB, but receive handlers trust names, MIME, size and `studentId` (`491–497`, `1175–1220`, `1693–1725`).

**Problem:** Custom peers bypass UI validation. Reproductions confirmed acceptance of HTML metadata, a forged student label and a false byte count. The approval check in `onMessage` runs after the library has received/reassembled the payload; it is not a pre-transfer resource gate.

**Fix:** Negotiate an offer first and reject unapproved peers/oversized files before accepting payload chunks. Use receive admission/budget APIs only if supported by the pinned Trystero release. Enforce actual received lengths, format rules and aggregate limits. Derive identity from the approved session, never file metadata.

**If we skip it:** Unexpected payloads consume memory and accepted files/log entries can be attributed to the wrong person. A library-wide memory budget does not replace the app's own limits.

### 7. An old disconnect timer can undo a successful reconnection

**What this is:** Student disconnect handling starts a four-second timer. `onPeerJoin` cancels it only when the peer ID equals the previous receiver (`1467–1487`).

**Problem:** If the desk returns with a new peer ID, the new receiver/approval messages succeed, but the old timeout still resets approval and displays Connection lost. This exact event sequence was reproduced.

**Fix:** Invalidate stale callbacks when the verified desk session reconnects; associate timers with a connection generation. Pause transfers immediately on transport loss and revalidate the target before each resumed send.

**If we skip it:** Reconnection can appear successful and then fail again because of old local state, even when the network path has recovered.

## Should fix

### 8. Essential code depends on mutable external CDNs

**What this is:** QR code, Tailwind and Trystero load externally (`8–9`, `325`); the logo is hosted elsewhere (`50`).

**Problem:** Blocking the Trystero CDN prevents the entire module from starting. An unversioned release can change APIs without a project commit. Page HTML loading does not prove all scripts/signaling hosts loaded.

**Fix:** Pin Trystero, bundle its dependencies, compile Tailwind, and serve the logo/QR script from the application's origin. Show a startup error if initialization fails. Use one reachable origin for assets and the proposed API.

**If we skip it:** Campus filtering, CDN outages or upstream updates can break an otherwise unchanged app.

### 9. Transfer IDs are not scoped to the sender

**What this is:** Upload IDs use millisecond timestamps and a file index (`1626`); incoming rows are keyed solely by `metadata.id` (`1180–1207`).

**Problem:** Two devices can generate the same ID. A custom approved sender can deliberately reuse one. The reproduction produced two receipt-log entries but only one visible row, with the second file replacing its actions.

**Fix:** Generate `crypto.randomUUID()` once per transfer, bind it to the approved sender/session, and use a composite receive key. Reject inconsistent duplicates while allowing matching retry chunks.

**If we skip it:** A download row can silently point to a different student's file.

### 10. Queued-file processing calls an out-of-scope function

**What this is:** `processPendingFiles` lives in `setupSender` (`1401–1407`), but `uploadFiles` is declared inside `initSenderConnection` (`1589`).

**Problem:** When pending files exist and approval arrives, `uploadFiles` is undefined in the caller's scope. The queue is cleared before that call. The ReferenceError was reproduced by exercising this pending-file path.

**Fix:** Put queue processing beside `uploadFiles` in the same scope and remove items only once the upload queue owns them.

**If we skip it:** A file selected through the pending path disappears from the queue without being sent. This is an edge path because the normal waiting overlay disables file selection.

### 11. Clearing files does not release their Blob URLs

**What this is:** Receive handlers create URLs; removal deletes rows without revoking them (`786–798`, `1199–1202`, `1700–1701`).

**Problem:** Repeated files and duplicate IDs retain byte buffers. Clearing the receive list was reproduced without any Blob URL revocation. Completed files, chat and logs also have no session-wide retention bound.

**Fix:** Store the URL alongside each transfer and revoke it on replacement/removal. Bound retained files and logs, close previews before deletion, and make browser-storage retention explicit.

**If we skip it:** A busy desk accumulates memory despite using Clear, increasing the chance of tab failure and losing unsaved documents.

### 12. Diagnostics cannot distinguish the important connection failures

**What this is:** `joinRoom` is wrapped in synchronous try/catch (`952–963`, `1439–1450`), and one global ping timestamp is used for all peers (`670–677`). Receiver UI says Connected immediately after creating a room (`972`).

**Problem:** Later signaling/ICE failures need asynchronous callbacks. Existing traces do not record selected candidates, relay transport, ICE states or unanswered pings. A room object is not evidence of a connected visitor; multiple pongs also make the latency label ambiguous.

**Fix:** Record separate startup, signaling, ICE, peer, approval and transfer states. Use supported join-error hooks, actual RTC statistics and peer-scoped ping IDs/timeouts. Export a bounded redacted log with each failure's timestamp stored at capture time.

**If we skip it:** Campus reports continue to say Connecting without identifying whether discovery, TURN, approval or transfer failed.

### 13. Custom TURN settings disappear from desk links and leak into diagnostics

**What this is:** TURN credentials are read from query parameters (`344–347`), but generated QR links include only mode and desk (`935`). Diagnostics capture the complete URL (`575–588`).

**Problem:** A desk using custom settings shares a link that sends students back to defaults. Exporting a full diagnostic context can also reveal `turnPass`; this inclusion was reproduced. URL credentials additionally enter browser history and may enter access logs.

**Fix:** Fetch shared non-secret configuration and short-lived TURN credentials from the backend. Redact credential/capability parameters in diagnostics. Avoid solving the link mismatch by copying secrets into every QR URL.

**If we skip it:** Participants can use inconsistent network configurations, and debugging exposes credentials.

### 14. CSV escaping does not neutralize spreadsheet formulas

**What this is:** `csvEscape` quotes values (`512`), including user-provided student labels and filenames (`681–692`).

**Problem:** `=1+1` is exported as `"=1+1"`; quoting does not make it literal text in spreadsheet apps. The exported text was reproduced; opening it in Excel was not tested.

**Fix:** Neutralize spreadsheet formula prefixes in exported untrusted fields, including leading whitespace/control-character variants. Keep the original values unchanged inside the app.

**If we skip it:** Opening a malicious log in a spreadsheet can evaluate unexpected formulas or links.

## Recommended design under the user's actual constraints

**Do not replace the UI or add an OCR engine, account system for every student, permanent document archive, or a collection of random public relays.** Keep the desk workflow and add one small transport/control backend.

Candidate: **Cloudflare Workers Free + SQLite-backed Durable Objects Free**, hosted with the bundled static frontend. Durable Objects keep the room's control state and a small temporary encrypted chunk buffer. Use ordinary HTTPS upload/download/status requests as the dependable candidate route; optional secure WebSockets improve latency when campus allows them. WebRTC remains the direct fast path.

Both browsers initiate outbound HTTPS requests. The desk does not accept incoming network connections and no always-on work PC or university server is required. This is a proposed architecture, not a tested deployment. Test its hostname from campus before committing to migration. Cloudflare recommends custom domains for production; the provided workers.dev address is a free pilot option with operational limitations.

Transfer behavior:

- The backend authorizes the desk separately from students and binds each transfer to that approved student.
- Split files into bounded chunks, for example 512 KiB, with stable IDs, sequence numbers, integrity checks and authenticated end-to-end encryption using browser cryptography. Authenticate endpoint identity during key exchange; the relay must not receive the decryption key.
- Buffer only a limited window of encrypted chunks, then stop accepting more until the receiver commits/acknowledges them. Never load a full 150 MiB file in a Worker or a single storage row.
- Delete acknowledged relay chunks and expire abandoned sessions. This is temporary forwarding, not a cloud document archive.
- Persist accepted chunks/progress locally when allowed; resume only missing ranges after reconnecting or switching transport. Keep expiry and user cleanup controls for sensitive documents.
- Keep WebSocket-free HTTPS operations available: replacing public signaling with another WebSocket endpoint alone cannot solve a network that blocks WebSockets.
- Prefer WebRTC when its path is healthy, but move a stalled transfer to HTTPS without generating a new logical transfer. Avoid repeated route switching and duplicate receipts.
- Bound polling, open sessions, chunk windows and retries. Aggressive polling by many idle students can exhaust a free request quota.

**Zero-cost limits:** Workers Free currently allows 100,000 requests/day and 10 ms CPU/request. Durable Objects Free supports SQLite storage, 100,000 requests/day, 13,000 GB-seconds/day of active duration, 100,000 row writes/day, 5 million row reads/day and 5 GB total storage. Its documentation says operations fail when free limits are exceeded. Keep the account on Free and avoid adding paid-plan services. Chunk size, storage operations, polling, retries and active duration must all be load-tested; these limits are not a claim that arbitrary campus traffic is supported.

A 150 MiB file also exceeds the 100 MB request-body limit on Cloudflare's Free account plan. Small chunks address that limit and the Durable Object 2 MB row/value limit. Encrypt/hash on clients and keep request handling lightweight.

**TURN alternatives:** Open Relay currently advertises 20 GB/month free with supported issued credentials. Cloudflare Realtime currently advertises a shared 1,000 GB/month SFU/TURN free allowance, but excess usage is chargeable; do not describe it as unlimited or zero-risk billing. It is optional, not required for the proposed HTTPS fallback. Coturn's software is free, but its machine/network capacity is not automatically free, and IT hosting is unavailable here.

**OCR comparison:** The earlier OCR project used an online frontend/gateway to reach a keyed work-PC service through a tunnel. A transfer relay follows the same broad frontend/backend pattern, but does no OCR. Reusing a work-PC tunnel is possible conceptually, but inherits PC sleep, tunnel availability and address stability. Quick Tunnels explicitly provide no SLA and are intended for testing, so they should not be the sole reliability plan.

## Campus diagnosis before choosing a route

1. From the actual desk PC, verify the frontend's essential script/module loads and signaling endpoint connections. Test Ethernet and Wi-Fi separately.
2. Test the same two-browser pairing with the desk on campus, then with the desk on a mobile hotspot. This better isolates desk-side policy than changing only the student network.
3. Use the official Trickle ICE sample to check supported TURN credentials from the desk network. A relay candidate proves allocation; perform an actual forced-relay transfer as a separate test.
4. Test a harmless HTTPS health request and small bidirectional chunk exchange to the proposed backend address. Test secure WebSockets separately.
5. If HTTPS works and WebRTC/TURN does not, select HTTPS for that network. If the backend hostname is blocked, pick/test an allowed hosting address; no transport guarantees operation when all destinations are blocked.

Do not diagnose client isolation alone: it cannot by itself explain every campus-to-mobile failure. Possible causes include signaling filters, outbound UDP restrictions, TLS inspection, unsupported TURN credentials, proxy rules, endpoint outages and the application's reconnect bugs.

## Fix order and acceptance checks

1. Patch desk authority, unsafe previews, receive validation, false success, stale timers and queued-file scope. Pin/bundle dependencies.
2. Add receipts, stable transfer IDs and readable connection diagnostics. Verify current TURN before discarding working WebRTC.
3. Pilot the free HTTPS backend from campus. Add resumable chunks and bounded persistence through the same transfer state for both transports.
4. Test a small document and a 150 MiB document; campus-to-mobile and campus-to-campus; UDP blocked; WebSockets blocked with HTTPS still allowed; temporary drops at 10%/50%/99%; desk refresh/new peer ID; student phone backgrounding; denied/forged peers; duplicate IDs; quota/storage exhaustion; 5–20 simultaneous students.

Required outcomes: no false Delivered state, no wrong-recipient file, matching integrity checks, no duplicate receipt after retry, automatic bounded recovery, clear messages when the destination/quota is unavailable, and bounded memory after repeated transfers and cleanup.

## Evidence and limits

`audit-checks.cjs` runs the downloaded module in a simulated DOM and transport. Eleven reproduction checks confirmed the exact application behaviors described above. This does not emulate browser WebRTC, campus filtering or native document rendering. The downloaded repository remains unchanged.

A local structural graph of the extracted inline JavaScript contains 67 nodes and 160 edges. Extraction used no external model API. The extracted module's line numbers require an offset to map back to the original HTML, so findings deliberately cite original HTML lines. Static graph edges do not prove runtime correctness.

Primary references, checked 12 October 2026:

- [Audited repository source](https://github.com/Ahmadfayad/P2P-Transfer/blob/2fe23dea44b5ddce4ee27996dd0f3374e1d96248/index.html)
- [Trystero documentation: strategies, action promises, file admission, signaling and TURN](https://github.com/dmotz/trystero#readme)
- [Open Relay: current credentials and free allowance](https://www.metered.ca/tools/openrelay/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Objects Free pricing and quota behavior](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Workers request-body/CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
- [workers.dev hosting limitations](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
- [Cloudflare TURN protocols/ports](https://developers.cloudflare.com/realtime/turn/)
- [Official WebRTC Trickle ICE test](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
- [ICE restart requires signaling/renegotiation](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce)
- [iframe sandbox and PDF limitations](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [Blob URL origin](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)
- [Quick Tunnel reliability limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

**Verdict:** Keep the product workflow, but fix endpoint authority and truthful delivery first. For campus use without IT hosting, test a free HTTPS fallback and make interrupted transfers resumable.

**Not checked:** Actual campus traffic, deployed CDN version, live legacy TURN credentials, browser exploit execution, Excel formula execution and real load capacity. No application changes, deployment, paid services or infrastructure were created. Free capacity and an allowed network destination remain required; uninterrupted connectivity cannot be guaranteed.
