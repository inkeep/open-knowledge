---
"@inkeep/open-knowledge": minor
---

Agent write/edit advisories now ride the unified validation plane: the up-to-10 findings on every `write`/`edit`/`agent-patch` response include broken internal links alongside lint violations, so an agent that writes a dead wiki-link hears about it on the write response itself — no separate `audit` round-trip. Dead-link entries carry the unresolved target verbatim (`linkTarget`), ready for a create-page fix, and honor the project's `validation.links` posture (hidden / warning / error). The write path refreshes the link index for the written doc before validating, so the very write that introduces a dead link is the one that reports it — the index's debounced update can't race the advisory. Still advisory-only: findings never block a write.
