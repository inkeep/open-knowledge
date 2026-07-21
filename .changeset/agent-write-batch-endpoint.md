---
"@inkeep/open-knowledge": patch
---

Add `POST /api/agent-write-batch`: apply up to 100 document writes in one HTTP call. Each entry uses the same write semantics as `POST /api/agent-write-md` (create or update, append/prepend/replace, per-entry summary, `.mdx` extension on create) and every entry is attributed to the calling agent. Outcomes are per-entry — a reserved doc name, merge conflict, or disk failure fails only that entry while its siblings land — and the response reports per-entry results with broken-link validation that resolves links between documents written in the same batch. The batch amortizes what N single calls pay N times: one round-trip, one presence/focus update, one admitted-doc-set scan for link validation, and one coalesced shadow-repo commit. The per-document mermaid render validation and lint advisories stay on the single-write endpoint.
