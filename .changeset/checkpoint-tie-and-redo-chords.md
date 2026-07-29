---
"@inkeep/open-knowledge": minor
---

Stop recovery-checkpoint cleanup from discarding the newest rescue point. Checkpoints written in the same second could not be ordered by their timestamps, so the sweep picked which one to drop essentially at random and could keep an older copy while permanently deleting the most recent one. Because loss-hardening writes one checkpoint per open document in a burst, the discarded copy could be a document's only recovery point. Cleanup now keeps every checkpoint it cannot confidently order, so it may hold slightly more than the retention budget rather than destroy the wrong one.

Correct the Source editor entry in the keyboard shortcut help. It advertised undo-selection shortcuts that source mode does not have; those shortcuts still work in the code block editor and in code-shaped property fields, and are now listed there instead. Redo shortcuts are unchanged and continue to work on every platform.
