---
'@inkeep/open-knowledge': patch
---

Folders no longer appear in the `[[` wiki-link picker. The shared suggestion corpus gained folder entries for the composer's `@` attach picker, and the wiki-link pickers were dressing them up as pages — selecting one inserted a link that opened the folder path as a document. Folders are now opt-in on the corpus fetch (only the composer asks for them) and the wiki-link item builder refuses folder rows outright. Proper folder links are tracked separately (PRD-7956).
