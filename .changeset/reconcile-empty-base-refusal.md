---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
---

Reconciling a document without an acknowledged base no longer concatenates it with itself: the detected disk change replaces the editor content and the prior version stays restorable from the timeline. A pre-write reconcile refused for a missing base is now tracked with its own reason, `refused-no-base`.
