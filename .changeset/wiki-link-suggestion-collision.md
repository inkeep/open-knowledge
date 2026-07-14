---
"@inkeep/open-knowledge": patch
---

Fix the `[[` wiki-link suggestion box silently freezing when a folder and a note share a name. The search index keyed every entry as `page:<name>`, so a folder `wiki` and a note `wiki.md` collided on `page:wiki`; the index rejected the duplicate key and the uncaught error killed the typeahead, leaving the dropdown stuck on the same initial results no matter what you typed. Entries are now keyed by their true kind (`folder:`, `page:`, `file:`), folders and assets are explicitly included in the corpus, and results map back to notes by the full kind-qualified key so a folder can't stand in for a same-named note.
