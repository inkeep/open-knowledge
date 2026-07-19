---
"@inkeep/open-knowledge": patch
---

Background shadow-repo garbage collection no longer races the write path. Previously, the maintenance gc (which packs and prunes the attribution journal's loose objects) could run concurrently with an in-flight auto-save commit; in the race window, git's object-directory cleanup could make the commit fail transiently (`unable to create temporary file` / `failed to insert into database`), logged as a per-writer shadow commit failure and dropping that flush's version-history entry until the next auto-save. Shadow mutations and the gc leg are now mutually exclusive: gc waits for in-flight commits to drain and briefly holds new ones until it finishes, so auto-saves can no longer fail because maintenance happened to run at the same time.
