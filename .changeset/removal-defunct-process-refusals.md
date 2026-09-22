---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
"@inkeep/open-knowledge-server": patch
---

`ok deinit`, `ok uninstall`, and the desktop uninstall flow no longer refuse to remove a project's local state over host uncertainty showing no evidence of a running server, such as an already-exited process. `ok clean` prunes a lock naming one. A live or unreadable server process still blocks both.
