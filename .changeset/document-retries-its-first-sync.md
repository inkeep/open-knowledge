---
"@inkeep/open-knowledge": patch
---

A document that fails its first sync now retries itself, at most three times, as soon as the connection reports it in sync, instead of holding the error screen for the life of the window. The stalled-sync warning also names the document it is about.
