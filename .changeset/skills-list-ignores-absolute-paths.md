---
'@inkeep/open-knowledge': patch
---

`GET /api/skills` no longer fails with a 500 when built-in skill bundles resolve to their source assets (fresh checkout or mid-build). The built-in row is now consistently listed as not ignored instead of inheriting ignore state from a build-artifact path segment.
