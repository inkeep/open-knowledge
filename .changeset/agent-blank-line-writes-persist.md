---
"@inkeep/open-knowledge": patch
---

`lint({ fix: true })` and `edit` now persist changes that only add blank lines, such as the MD022 fix that inserts a blank line below a heading. Previously the server reported the fix as applied while the file on disk stayed unchanged, because the persistence layer compared the new content against the last on-disk bytes through a normalizer that tolerates missing block separators and concluded nothing had changed. Agent-triggered writes now compare bytes exactly. The exact-byte comparison also survives a store that a concurrent editing burst defers, so a blank-line-only write made during that window still reaches disk on the next flush.
