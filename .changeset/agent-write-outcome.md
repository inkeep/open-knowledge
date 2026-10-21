---
'@inkeep/open-knowledge': minor
---

Agent writes to Markdown documents, templates and project skills report `outcome`, `saved` and `nextStep`. `agent-write`, `agent-write-md`, `agent-patch` and `frontmatter-patch` answer 409 `both-kept` or 503 `save-held` where they answered 200: those writes landed, so do not retry. `retryWhen` and warning-level `nextStep` are deprecated.
