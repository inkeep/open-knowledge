---
"@inkeep/open-knowledge": patch
---

The `exec` MCP tool's post-command mutation safety sweep is now scoped to the paths the command can actually touch (its own path operands), instead of statting up to 1000 files across the whole knowledge base twice on every call. Path-scoped commands like `cat notes/a.md` or `grep -rn oauth articles/` now sweep only those paths, making exec noticeably cheaper on large knowledge bases. When the sweep does cover the whole tree (bare `ls`, `find`, recursive `grep` with no directory) and the corpus exceeds the 1000-file scan cap, the response now carries an explicit warning that mutation detection was partial, instead of silently presenting a capped sweep as full coverage.
