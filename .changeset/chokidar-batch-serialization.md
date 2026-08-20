---
'@inkeep/open-knowledge': patch
---

Fix unbounded heap growth of the chokidar file watcher fallback on Windows. Batches are now drained strictly one at a time, so event storms no longer pile up overlapping async work.
