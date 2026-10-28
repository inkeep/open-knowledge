---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
---

Agent installs such as OpenCode no longer fail on slower connections after two minutes. Downloads resume after a dropped or stalled connection, and give up only when repeated attempts make no progress.
