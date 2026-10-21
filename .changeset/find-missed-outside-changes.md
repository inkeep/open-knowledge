---
'@inkeep/open-knowledge': patch
---

Outside edits the file watcher misses now appear within seconds, or about two minutes on very large projects: OpenKnowledge re-checks the project on a timer, watches again after a watcher failure, and re-reads open documents when the window regains focus or reconnects. Large projects use less memory.
