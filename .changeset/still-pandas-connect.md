---
"@inkeep/open-knowledge-app": patch
---

Fix the Settings dialog's hidden title wiring so Radix can associate `DialogContent` with its `DialogTitle` for screen reader users.

Coalesce overlapping GitHub auth-status checks in the HTTP transport so opening multiple auth-aware surfaces at once does not trip the local operation concurrency guard.
