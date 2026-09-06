---
"@inkeep/open-knowledge": patch
---

The visual editor no longer discards a keystroke, or destroys a list, after two lists become adjacent.

Emptying a paragraph that sits between two lists leaves a document markdown cannot spell: the source it writes re-parses to a single merged list, while the editor still shows three blocks. The editor used to keep both, and the disagreement was paid for by the next keystroke — typed at the end it was dropped without reaching the file, and typed in the first list it overwrote the second one, taking that list's content with it.

The editor now re-derives the document from the source at the moment it finds the two cannot be reconciled, so the lists merge visibly and immediately instead of a keystroke later. Nothing typed is lost, the next keystroke lands normally, and the recovery is recorded in the log as a warning.
