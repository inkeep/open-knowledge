---
'@inkeep/open-knowledge': minor
---

Read-posture hardening: every `/api` read and content-asset serve now validates the Host header, closing a DNS-rebinding read-exfil hole on exposed servers.

- Previously, mutating routes were Host-gated but reads (`GET /api/*`) were Origin-gated only in normal mode. A DNS-rebound page's same-origin GET carries no Origin, so document content could be read cross-origin under exposure. Reads now share the same Host admission writes already use: a request must present a Host in the admitted set (loopback names, `server.bind` literals, `server.publicUrl` host) or it is refused with `403 host-not-allowed`. This is the no-auth compensating control — no credentials are involved.
- Content-asset serving (`/api/asset` sibling static path) is gated the same way, so uploaded images/PDFs/attachments can't be read under a rebound Host either. The extension-less SPA shell stays reachable under any Host (it's public bundle code); only actual content-serve attempts are gated.
- If you reach a server by a hostname it hasn't been told about, reads now return `403 host-not-allowed`. Declare the name via `server.publicUrl` (or bind to it via `server.bind`) so it's admitted. Loopback access (`localhost`/`127.0.0.1`/`[::1]`) is unaffected, as is any first-party client on a loopback-shaped Host.
- `createAssetServeMiddleware` (from `@inkeep/open-knowledge-server`) now takes a required `ingressPolicy`. Surfaces with a resolved runtime pass their boot-built policy; loopback-only surfaces (the Vite dev plugin, the `ok ui` sidecar) pass `buildIngressPolicy({})`. This is a required-parameter addition on a package export, but `@inkeep/open-knowledge-server` is `private: true` (never published to npm — internal to the `@inkeep/open-knowledge` CLI), so it is not a public-API break; the bump is `minor` on the only published package, whose CLI command surface is unchanged.
