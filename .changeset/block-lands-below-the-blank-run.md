---
"@inkeep/open-knowledge": patch
---

A block inserted after blank lines is written where you put it, not above them.

Press Enter a few times at the end of a document, then turn the last empty line into a heading or start a new paragraph there, and the new block was written into the source immediately after the last line that had text on it — the blank lines you had just made were pushed down below it. Typing `hello`, pressing Enter eight times and applying a heading produced `hello`, one blank line, the heading, and then the run of blanks, instead of `hello`, the run, and then the heading. The same misplacement moved a block written over one of the blanks in an interior run above the whole run.

The block being edited was addressed by its position in the document but written at the source offset of the nearest earlier line that spelled bytes, because an empty line occupies no bytes of its own to write into. The source region between the blocks on either side of a blank run is now rewritten as a whole, so the blanks kept above the new block, the block itself, and the blanks kept below it all land in the order they appear on screen.

A single blank line held at the end of a document is still held, and blank lines above the first block are still not written; that gap is unchanged. A blank line that a new block lands after is no longer held, since it is no longer at the end.
