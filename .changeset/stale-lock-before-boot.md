---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
---

A project now opens after a restart even when its old server's process ID was reused by a process OpenKnowledge cannot inspect, such as a protected Windows service.
