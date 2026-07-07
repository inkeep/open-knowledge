---
"@inkeep/open-knowledge": patch
---

Fix the Git auto-sync and semantic-search toggles silently having no effect until
the server restarts. Config changes made in the editor are now applied to the
running server immediately, without depending on the filesystem watcher echo
(which could drop the event on some platforms, notably Windows). The server now
re-applies a validated config change to its live consumers directly at persist
time, so toggling auto-sync or semantic search on or off takes effect right away.
