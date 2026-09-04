---
"@inkeep/open-knowledge": patch
---

A document that moved on disk while you had it open no longer strands the tab.

When a git-sync pull (or an external `mv`) reorganized folders underneath you, the open tab stayed bound to the document's old path. The editor kept rendering the content it already had, but the Outline panel queried a path that no longer existed and showed a red "Page not found." next to a heading count left over from before the move. That error never cleared, because once the old path dropped out of the page list the panel could no longer refetch it.

Two things changed:

- **The tab follows the document.** A move seen by the file watcher now closes the agent sessions and client connections holding that document, as a move made from the sidebar already did. The existing rename-redirect handshake then points each tab at the new path. Moving the document back works too: the tab follows it home and keeps saving, where before the returning path was served a stale copy that silently refused every write. Edits that had not yet reached disk when the move landed are written to the rescue buffer rather than discarded, though reaching them still needs support: they do not yet appear in the Timeline of the document you are rebound to.
- **Panel headers stop disagreeing with their bodies.** The Outline, Backlinks, Outgoing, and Local files counts are hidden whenever that section is showing an error, and each of those panels now says plainly that the page is no longer at this path instead of reporting a confident zero. A document that leaves the page list also stops leaving a stale Outline result cached behind it. This covers any failed fetch, not just a move.
