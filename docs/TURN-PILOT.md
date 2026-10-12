# Open Relay pilot

This is a staged transport change, not a Cloudflare migration. The existing service still enforces employee login, room ownership and student approval. Hibernating WebSockets send only `changed` hints; clients fetch protected state through the existing authenticated API. Private peer tokens travel in the socket protocol header, never the URL, attachments, response protocol or diagnostics. The response selects only `uos-staff-v1` or `uos-guest-v1`. Connections renew after eight minutes, have a ten-minute authorization lifetime and close when the room or visitor ends. HTTP polling remains available if upgrades fail.

The sender maintains a bounded four-chunk encrypted stream. A receiver saves and verifies every chunk before acknowledging a batch of at most four. Lost acknowledgements replay the saved offset; receipt still requires a completely assembled saved file. Old clients can use individual acknowledgements, and new clients use batches only when the server advertises support. Optional ICE setup runs outside the transfer tick. Complete direct packets and server notifications wake the client immediately instead of waiting for an idle poll.

## Private setup

1. Create an **Open Relay Free** account at https://www.metered.ca/tools/openrelay/. Do not enable a paid subscription or automatic paid overage. Check the provider's free usage limit before each pilot.
2. In the provider dashboard, create a temporary TURN credential with an expiry of no more than 24 hours. Wait for propagation before testing; the provider documents that newly created credentials can take up to two minutes to become usable. Keep the username and password private. Do not paste either into chat, GitHub, logs or project reference files.
3. In this repository's PowerShell terminal, run `./scripts/configure-turn-pilot.ps1`. Enter the temporary username/password at its masked prompts and a validity period no longer than the credential's remaining lifetime. Wrangler must already be privately signed into the existing Cloudflare account. The script writes the `TURN_PILOT_CONFIG` Worker secret through stdin; it does not put credentials in files or command-line arguments.
4. Refresh the desk and phone, approve the student, and send a small PDF with both browsers visible. Export both sanitized logs. An ICE candidate type of `relay` confirms the actual TURN route; code support alone does not prove the provider or campus route works.

The script uses `turns:standard.relay.metered.ca:443?transport=tcp`, the Free standard relay, and a default monthly pilot reservation cap of 256 MiB. `TURN_PILOT_CONFIG` contains `expiresAt`, `maxBytes` and `iceServers`; validation permits only standard Open Relay URLs, at most four servers, credentials up to 256 characters, expiry within 24 hours and a maximum 1 GiB reservation cap. Malformed, absent or expired configuration disables TURN without breaking HTTPS.

TURN credentials necessarily reach approved browsers so ICE can authenticate. No provider account-management key is needed or exposed. The app conservatively reserves four times an offered file's size against its monthly pilot cap. Once exhausted, new files use HTTPS. Reservations are never automatically increased or upgraded. This caps this client's planned relay use, not the provider's total metered traffic or abuse of copied credentials; the provider account must stay on its bounded Free plan. Stop the pilot by removing the Worker secret. Existing documents remain locally saved.

## Verification

Unit checks cover configuration rejection, approval/ownership, bounded pilot reservations, batch acknowledgement bounds and redaction. Chromium checks cover stored-before-batch-ACK recovery, blocked direct packets, exact bytes after refresh/lost acknowledgement, immediate notification-driven UI and the student/staff gate. `tests/native-sockets.mjs` exercises the actual compiled Worker and SQLite Durable Object in a disposable workerd runtime, with fixture employee headers isolated to that test entry. It checks upgrade handling, protocol-header authentication, ownership, bad origins, guest approval hints and revoked connections. No fixture entry is deployed and no real employee credentials are used in those automated checks.

Live TURN speed, university firewall compatibility, background-phone behavior and provider quota accounting remain campus-pilot checks. Keep the current service available until the new route has been measured successfully.

Provider references: https://www.metered.ca/tools/openrelay/ and https://www.metered.ca/docs/turnserver-guides/expiring-turn-credentials/.
