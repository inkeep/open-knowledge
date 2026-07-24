---
"@inkeep/open-knowledge": minor
---

Open Knowledge now has a unified content audit that reports markdownlint problems and broken links together. A new `audit` MCP tool and a new read-only `GET /api/audit` endpoint run both validators in one call — over the whole project or scoped to a folder or single doc via `?path=` — and return one normalized per-file diagnostic plane in which every finding is tagged with its source (`markdownlint` or `links`). Broken-link findings are grouped under the doc that contains the link (the file you would edit to fix it), with the message naming the unresolved target; their severity follows the project's `validation.links` setting (warning by default, raisable to error, or hidden entirely).

Dead-link findings now also carry the source line of the offending link, giving them jump-to-line parity with lint diagnostics (line exact; column approximate). Existing surfaces are unchanged: the `lint` and `links` MCP tools and the `/api/lint`, `/api/lint/audit`, and `/api/dead-links` routes behave exactly as before, and backlink caches written by earlier versions load cleanly — entries gain positions as their docs are re-indexed.
