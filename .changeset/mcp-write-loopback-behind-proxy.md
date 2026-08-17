---
"@inkeep/open-knowledge": patch
---

Fixed MCP write tools (`write`, `edit`, `move`, `delete`, and related) returning `HTTP 401` when the server runs behind an authenticating reverse proxy with `--external-url`/`OK_EXTERNAL_URL` set to the public origin. The tools' internal server-to-self API calls were being issued against the public, auth-gated URL, so they hairpinned out through the proxy and hit the login gate instead of the local server. These self-calls now always target loopback, so a single `OK_EXTERNAL_URL` pointing at your public origin gives working remote UI, reads, and writes at once. User-facing preview and share links are unaffected — they were never derived from this URL.
