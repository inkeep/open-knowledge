---
'@inkeep/open-knowledge': patch
---

Files written into a freshly created folder no longer go missing from page listings, search, and the collaboration layer when the watcher's per-directory subscription loses the race with the write (seen on Linux under load, e.g. `mkdir notes && cp draft.md notes/`). The new-folder rescan that already recovered dropped subfolders now recovers the files inside them too, replaying them through the normal change pipeline.
