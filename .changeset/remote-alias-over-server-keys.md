---
"@inkeep/open-knowledge": minor
---

`ok start --remote <url>` is now a thin alias over the ratified `server.*` networking keys: it expands to `server.publicUrl` (the tunnel URL), `server.allowExternal` consent, and a loopback bind, flowing through the same resolution path every other exposure route uses — the dedicated remote-access machinery is gone. Behavior over the tunnel is unchanged (same Host/Origin admission, same stable port default, idle-shutdown stays off), with one improvement: issued URLs (MCP `serverUrl`, `preview_url`) now name the tunnel URL instead of an unreachable loopback address. The flag is deprecated and prints a notice pointing at its successors; a new `--public-url <url>` flag sets `server.publicUrl` for a single run. `--remote` and the `remote.*` config keys keep working for now and will be removed in a later release.
