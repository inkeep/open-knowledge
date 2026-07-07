---
"@inkeep/open-knowledge": minor
---

Share links now tell you at share time when the link won't show what you see. When you copy a share link for a doc or folder that isn't on GitHub yet, or that has unpushed changes, the share popover shows a non-blocking warning — for example "This doc isn't on GitHub yet. The link won't work until it's pushed." or "This doc has unpushed changes. Recipients will see the last pushed version." The warning stays out of the way when the target is already up to date (and when auto-sync will publish the change on its own). The `share_link` MCP tool relays the same signal so agents don't hand over a dead link as if it were good. The freshness check is local-only — it never reaches the network, and it never blocks or fails the share.
