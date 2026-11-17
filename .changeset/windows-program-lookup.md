---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-core': patch
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge-server': patch
---

On Windows, OpenKnowledge's own processes and the agents it starts no longer run a program from their working directory when it is named without a path. To run one from that directory, put `.\` before its name.
