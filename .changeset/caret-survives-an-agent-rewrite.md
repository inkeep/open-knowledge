---
"@inkeep/open-knowledge": patch
---

The caret no longer jumps to the start of a paragraph an agent rewrites.

With the caret resting at the end of a paragraph, an agent edit to that paragraph moved the caret to the paragraph's beginning, so the next thing typed landed in front of the agent's text instead of after it. A caret in the middle of the paragraph was moved to the beginning too; only a caret already at the beginning was unaffected, which is why the problem was easiest to notice at the end of a line.

An agent edit arrives as a removal of the whole paragraph followed by an insertion of its replacement, and the editor treated the removal as if the text had simply been deleted, collapsing any caret inside it to where the removal began. It now recognises that the two halves share most of their text and keeps the caret where the surrounding words put it.
