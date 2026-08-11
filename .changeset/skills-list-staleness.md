---
"@inkeep/open-knowledge": patch
---

The skills list no longer gets stuck showing a skill's pre-change state after you install, remove, convert or move it. Every surface that shows skills shares one request to the server, and a refresh triggered by your change could latch onto a request that had already been sent before it — so the list settled on what was true a moment earlier and stayed there until something unrelated refreshed it. Refreshes now recognise a request as predating the change and issue their own instead.
