---
"@inkeep/open-knowledge": patch
---

Agent edits made during a Git branch switch now wait up to 20 seconds for it to finish before applying. An edit whose save the switch drops within that wait returns a `branch-switched` error instead of reporting success.
