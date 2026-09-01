---
"@inkeep/open-knowledge": patch
---

The append-only change log (`log.md`) is no longer reported as having broken outbound links. An append-only audit trail legitimately references documents that were later moved or deleted, so a link in it that no longer resolves is expected history, not an authoring defect. Until now, appending an entry re-surfaced a broken-link warning on every write; the reserved log is now exempt from broken-link reporting. Matching is by basename and extension-insensitive, so the root `log.md`, a nested `wiki/log.md`, and `.mdx` variants all qualify, while ordinary documents that merely contain "log" in their name (`changelog`, `blog`, `logs/2026-01`) are unaffected.
