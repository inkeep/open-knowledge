---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Keep desktop smoke window discovery polling when another Electron page is slow to answer. Each page now has at most one mode probe in flight, so a newly ready editor is found without waiting behind an older stuck page.
