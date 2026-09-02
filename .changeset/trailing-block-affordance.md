---
'@inkeep/open-knowledge': patch
---

A document whose last block is a table, list, or code fence no longer grows a blank line at the end of the file that nobody typed.

The visual editor used to keep an empty paragraph below such a block so there was somewhere to click. That paragraph was a real part of the document rather than a piece of interface, so it serialized to a blank line and landed on disk, and an MD012 lint warning came with it.

That paragraph is gone. In its place, hovering the empty space below the final block shows the same plus you already see beside every other block, at the same spot in the gutter. Clicking anywhere in that space adds the line and puts the cursor in it, so the newline in your file is one you asked for. On a touch device, where there is no hover to read, the plus stays visible whenever the space is there to use, and on a narrow screen it sits at the left edge of the text rather than out in the gutter. Arrow keys still move past the final block as before, and the cursor that lands there is now visible on the dark theme instead of drawing in black.

Two things worth knowing. A file that already picked up the extra blank line keeps it, because OpenKnowledge no longer removes trailing blank lines it did not write. Clear it with Auto-fix in the Problems panel, with `ok lint --fix`, or by hand. And Backspace immediately after a list autoformats (typing `- ` and getting a bullet) now restores the literal characters you typed no matter where you are in the document. It used to do something different on the last line than everywhere else.
