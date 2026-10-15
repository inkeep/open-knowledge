---
"@inkeep/open-knowledge": patch
---

OpenKnowledge Desktop's editor, note, navigator and terminal windows now apply a Content-Security-Policy and refuse to load local files from outside the app bundle, which stops scripts injected into the page from running.
