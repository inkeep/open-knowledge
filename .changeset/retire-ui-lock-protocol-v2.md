---
'@inkeep/open-knowledge': minor
---

Retire the `ui.lock` sibling advertisement and bump the cross-process protocol to v2.

A server that serves the editor now advertises the UI through a single record — its own `server.lock` carrying a `ui` capability — instead of writing a separate `ui.lock`. Preview-URL resolution, the clone→open redirect, and `ok status` / `ps` / `stop` / `clean` all read that one record. For one release of upgrade goodwill, `ok stop` still SIGTERMs a lingering pre-migration `ok ui` holder and `ok clean` still prunes a leftover `ui.lock`.

The split-mode `ok start --only ui --server-url` proxy is removed: plain `ok start` serves the editor, API, and MCP on one port. `ok start --only server` stays for headless and container use.

The cross-process protocol version is now 2 — the deliberate break that marks this release incompatible with older peers. A previous-stable desktop attaching to a v2 server classifies the mismatch and surfaces the version-drift prompt (with a restart action) through the existing desktop attach-drift check, instead of silently running on against an incompatible server.
