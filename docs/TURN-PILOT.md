# Historical TURN pilot — disabled

The previous branch experimented with a bounded Open Relay/Metered TURN pilot. The streaming service explicitly disables that provider, following the current project requirements. `turnPilot()` returns null even when an old private credential remains configured. No credential is returned to the browser, no TURN reservation is made for new offers and no new account or paid service is used.

Existing pilot metadata and secrets are not deleted or reset. Do not run the old setup helper or enable a provider for this streaming deployment. The supported path is ordinary direct WebRTC with Google STUN when it works, and browser-encrypted HTTPS streaming through the existing Cloudflare service when it does not.

See [STREAMING.md](STREAMING.md) for transport details, tests, browser limitations and performance evidence. Historical source and setup instructions remain in Git history.
