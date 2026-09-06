---
"@inkeep/open-knowledge": patch
---

When a disk change overwrites unsaved edits, the server records what was lost again.

Three places on the server take a checkpoint before letting content from disk replace what is live in the editor — a divergence realign, a duplication reset, and a managed-artifact reconcile. Each one also asks a detector to name the lines that were about to be discarded, so the loss is written to the diagnostics ring alongside the checkpoint. That request stopped being answered: the function applying the disk content had been reduced to two parameters while its callers still passed six, so the detector was handed over and silently dropped on every call.

The checkpoints never stopped, so nothing was ever unrecoverable — the discarded content was always still retrievable. What went missing was the record of *what* had been at risk, which is the part someone reads when they are trying to work out what happened.

The detector is wired back up, and the loss events reach the ring again.
