---
"@inkeep/open-knowledge": patch
---

**View in source works from the bubble menu again**, and switching between rich text and Markdown now finds the block you were looking at by reading the document's byte map rather than counting blocks.

- **The "View in source markdown" button in the selection toolbar did nothing when clicked.** It asked the editor for the document it is bound to, and asked by the name of a collaboration extension the editor stopped using two releases ago — so the answer was always "no document" and the button gave up without a sound. The keyboard shortcut was unaffected, because it takes a different route to the same document, which is why the two behaved differently.
- **An agent's edit now flashes inside a raw MDX block's nested source editor.** The same wrong lookup meant the highlight was never installed there at all.
- **Switching modes with a blank line at the top of your view now lands.** The old path asked for the blank block's byte range, got an empty one, and gave up — no scroll, no landing. Blank lines are held open by a zero-width span, which the byte map understands and a byte range does not.
- **The landing target is resolved through the source map instead of by counting children.** Counting agreed with the map on every document we measured and stops agreeing the moment a document does not parse, which is exactly when it would scroll you to a position taken from a document that no longer exists.
- **A mode switch on a document whose Markdown cannot be parsed no longer guesses.** There is no block table to anchor to, so the switch happens without a landing animation rather than scrolling to a block index that means nothing.

Internal cleanup that ships with it: the last block-index-to-position helper is gone, and the JSX identity plugin no longer carries an arm that resolved a mapping the editor stopped creating two releases ago.
