---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
"@inkeep/open-knowledge-app": patch
"@inkeep/open-knowledge-core": patch
"@inkeep/open-knowledge-server": patch
---

Dismiss the macOS uninstall result after revealing its cleanup log. Restore the localized completion checklist with Cleanup log and Reveal in Finder controls, keeping progress visible while the original app exits and cleanup runs. Use a disposable profile, exit before Finder reveal, and fall back to the system result dialog if the helper fails or its renderer stops responding.

Allow uninstall and project deinitialization to recover malformed server-lock residue only after successful process and listener inspection finds no associated live server candidate. Preserve recovery of dead PID-only locks. Global-only uninstall can retain project state whose lock records another machine or an unverified owner; deinitialization still refuses those locks. Read failures, incomplete inspection, and live server candidates remain blockers. `ok clean` now reports access and ownership refusals, while `ok status`, `ok ps`, and `ok diagnose` identify live PID-only records as having an unverified owner. `ok stop` will not signal those records, even with `--force`.

Clean up owned temporary lock fixtures. Report dependent cleanup skips separately from root failures in human output, retain the JSON `failed[]` contract, and expose blocked dependent operations in an additional `blocked[]` array.
