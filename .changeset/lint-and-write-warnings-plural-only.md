---
"@inkeep/open-knowledge": minor
---

The success responses of `/api/agent-write`, `/api/agent-write-md`, `/api/agent-patch`, `/api/frontmatter-patch`, `/api/rollback` and `/api/lint/fix` remove the deprecated singular `warning` field. Write and rollback advisories use the plural `warnings` array; every advisory the singular carried was already present in `warnings` on the same response, so a caller that reads the plural sees no change.

For `/api/lint/fix`, a durable fix whose post-write re-lint throws or loses a lint source that succeeded before the fix returns `diagnosticsArePreFix: true` and `reLintFailure: { reason, message }`, where `reason` is the closed discriminant `re-lint-threw` or `source-went-blind` and `message` is the prose explanation. The reported `diagnostics` and their `errorCount`/`warningCount` are the pre-fix set and may overstate what remains. `fixedCount` is 0 because the post-fix count could not be determined, not because nothing was fixed. Treat the fix as applied and re-run `lint` to confirm. Configuration and plugin warnings remain in `warnings`; the endpoint no longer emits a `Re-lint after fix failed: ` entry.

The MCP lint text renderer is the reader this change migrates. The editor's Problems panel calls the same endpoint for `Fix all`, discards the response body and re-audits the project when the sweep settles, so it never read the singular field and does not read the new flag.

The MCP `lint` renderer recognizes the boolean, the typed `reLintFailure`, and legacy prefixed entries in either `warnings` or singular `warning` as pre-fix signals. It emits `diagnosticsArePreFix: true` for any of these signals and puts a trimmed, non-empty explanation in `reLintFailure.message` with the discriminant in `reLintFailure.reason`, preferring the typed server failure over legacy entries; a legacy entry normalizes to `reason: 're-lint-threw'`. The flag can be present without `reLintFailure` when no non-empty message is available. Both the structured `warnings` array and the human warning block exclude legacy prefixed entries and retain ordinary warnings.

The reverse pairing is the one that degrades, and it is reachable because `ok mcp` attaches to whatever server is already running rather than pinning one. An `ok mcp` published before this release, pointed at a server from this release or later, reads only the removed singular field, so it loses the pre-fix header and reports the pre-fix diagnostics as remaining work. Upgrade both together.

Restart the server and MCP client after upgrading to load both updated components. `ok stop` declines while an editor window or agent is still connected, so close them first or run `ok stop --force`, then `ok start`. Run it from anywhere inside the project; `ok stop` anchors to the enclosing project root. From outside, name the target with `ok stop <path>`, or `ok stop all` to stop every running server. If the desktop app is hosting the server, quit and reopen it.
