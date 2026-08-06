---
"@inkeep/open-knowledge": patch
---

Shutting the server down now waits for in-flight history writes to finish before releasing the history repo. Content-loss checkpoints are written in the background and are never awaited by the editing path, so a burst of them could still be running its git work when shutdown released the repo out from under it. Those writes then landed after the server considered itself stopped, re-creating history state moments after teardown — and anything removing the project directory right after a shutdown could fail partway through. The wait is bounded by the existing shutdown timeout, so a stuck git process still cannot hang exit.
