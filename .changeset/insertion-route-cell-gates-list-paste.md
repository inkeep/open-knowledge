---
"@inkeep/open-knowledge": patch
---

Two editor insertion-route fixes.

Block components (Callout, and any block-level JSX component) can no longer be placed inside a table cell, where they previously disappeared on save: a table cell has no markdown spelling for block content, so the component serialized to zero bytes while still showing in the editor. Every insertion route now refuses it as a silent no-op — the slash menu omits block-component entries when the caret is in a cell, and pasting or dropping a block component into a cell leaves the document unchanged. Placing the same component outside a cell is unaffected, and content that already carries a component in a cell (from a collaborator or a raw file edit) is left alone rather than fought.

Pasting copied list items at a list-item boundary now lands them as sibling items instead of mis-placing them (inkeep/open-knowledge#609). Pasting at the start of an item puts the copied items above it, at the end puts them below it, and mid-item splits the item at the caret. Task, bullet, and ordered lists behave the same way, nested lists inside the pasted items are preserved, and pasting a whole component or table still reproduces it byte-for-byte.
