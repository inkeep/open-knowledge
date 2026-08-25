---
"@inkeep/open-knowledge": patch
---

The bundled agent skills now match the MCP tool surface. `links` is called with the parameter names the tool accepts (`document`, `sourceDocuments`), `audit` is named as the end-state check and described by what it actually reports (every lint violation plus every broken internal link, not just dead links), with `links({ kind: "dead" })` as the graph reader and a superset of `audit` on the source side, external images route through the ingest procedure instead of an ad-hoc fetch, and the OKF reserved-file frontmatter exemption is documented. The project skill refreshes on its own. A pack skill already seeded into a project is yours to edit, so it keeps its old text and seeding again will not refresh it; update that skill from source, or delete it and reseed, to pick up the corrected wording.
