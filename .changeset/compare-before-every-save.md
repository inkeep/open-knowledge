---
'@inkeep/open-knowledge': patch
---

Saving a Markdown document in the app, by an agent, while idle or at quit now checks the file first and merges an outside edit instead of writing over it. Agent writes over a changed file are merged instead of refused with `urn:ok:error:disk-divergence`, which is retired.
