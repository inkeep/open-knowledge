---
"@inkeep/open-knowledge": patch
---

The visual editor now records why it refused an edit instead of discarding it in silence.

Five places in the projection binding could drop or downgrade a keystroke with no trace: a refused source splice, which discards the edit and rebuilds the document; a write that cannot reach the document it belongs to; a refused rebase, which makes every later keystroke pay a whole-document re-parse; a re-projection that disagrees with the editor about how many blocks there are; and a block table left stale because the document held blocks the source could not account for. Each of the eleven guards behind those now carries a name, and the binding writes it to the log — as a warning for the two that lose work, as information for the rest.

Nothing about editing changes: an edit that landed before still lands, byte for byte, and an ordinary keystroke writes nothing to the log at all.
