---
'@inkeep/open-knowledge': patch
---

Documents, folders and skills whose names begin with `:` or contain `*` or `?` now sync, show history and report share status the same way any other name does.

Git reads the file names Open Knowledge passes it as a pattern language, not as plain names, and the app was handing them over unprotected. A note named `:scratch.md` failed the whole push cycle, so nothing in that cycle reached your remote. A note named `:!draft.md` was read as an instruction to *exclude* files, so it was quietly dropped from the commit it belonged to and never left your machine — with no error to suggest anything was missing. Names containing `*` or `?` matched siblings instead of themselves, so version history, share freshness, share target status, document rename and skill restore could answer about the wrong file, and switching a wildcard-named skill to local-only could be blocked by a remediation list for a file that was never tracked.

Every place the app hands a file name to git now marks it as a literal name. Documents that were skipped will sync on the next push, and no renaming is needed.
