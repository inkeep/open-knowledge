---
'@inkeep/open-knowledge': patch
---

**Fix:** the code-block chrome's Ask AI now grounds the composer with the
selected block's fenced source on first click, matching the second-click and
text-selection Ask AI paths. Previously, when no terminal was live, the
composer opened with an empty pill and the receiving agent got no passage.
