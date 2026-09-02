---
"@inkeep/open-knowledge": patch
---

The server now logs a one-time diagnostic the first time it refuses a request carrying a forwarding header (`X-Forwarded-For`, `Forwarded`, etc.). The refusal itself is not new — a server that has not consented to external exposure has always refused proxied requests on every surface except the `/healthz` and `/readyz` probes — but the reason was easy to misread as a proxy misconfiguration. The new message names the fix: set `server.externalUrl` to the public origin in `.ok/config.yml` (or `OK_EXTERNAL_URL`) AND consent with `server.allowExternal: true` in `.ok/local/config.yml` (or `OK_ALLOW_EXTERNAL=1`) — the keys live in different files because consent is per-machine and must not travel; tolerance for forwarding headers requires the pair. `server.allowExternal` consents to exposing a server with no authentication of its own, so only set it behind an authenticating edge.
