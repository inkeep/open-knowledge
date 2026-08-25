---
"@inkeep/open-knowledge": minor
---

Report which checks actually ran. Every successful `ok lint` / `ok audit` report, HTTP response, and MCP `lint` / `audit` result now carries `ran`, naming the source families selected for that call, so a clean result is no longer indistinguishable from one where the check you cared about was switched off. A family absent from `ran` was not checked, and `[]` means nothing was.

A selected check that fails stays in `ran` and is explained in `warnings`, and the summary line says the run could not fully complete rather than reporting clean. On `POST /api/lint/fix`, the singular `warning` field is deprecated: read `warnings`, which now carries the same post-write re-lint failure alongside plugin failures.
