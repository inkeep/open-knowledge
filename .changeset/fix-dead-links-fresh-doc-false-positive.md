---
"@inkeep/open-knowledge-server": patch
"@inkeep/open-knowledge": patch
---

Fix `links({ kind: "dead" })` falsely reporting freshly-written docs as dead. The dead-link check decided a target existed only from the file-watcher's file index, which lags behind in-session writes, so a doc the link graph had just registered a backlink for could still be flagged dead until a server restart. Dead-link resolution now also treats any doc the graph already holds as a live node (its body has been indexed) as a valid target, so a newly-written doc is a valid link target immediately — without changing how genuinely-missing targets are reported.
