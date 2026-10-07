---
"@inkeep/open-knowledge": patch
---

Agent writes to a busy local project now answer as soon as they are saved, carrying a `link-check-deferred` warning when link checks were skipped. A write refused because the project is overloaded now says that nothing was saved, so it is safe to retry.
