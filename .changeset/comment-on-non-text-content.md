---
'@inkeep/open-knowledge': minor
---

Comment on code blocks and table rows.

Dragging a selection across a code block and asking for a comment failed with "The quoted passage is not in the document." A fenced block's backticks were already invisible to the anchor matcher, but the language tag after them was not, so any selection crossing into or out of a ` ```ts ` block could not be located. The same gap closed for thematic breaks, setext heading underlines, table delimiter rows, table cell boundaries, and task-list checkboxes — every source line that renders as nothing.

A code block's sparkle button used to hand the whole block straight to a fresh agent session, with no way to file the note for a later batch. It now opens the same composer the text toolbar's Ask AI opens, offering both. A selection already inside the block is what the comment is about; with nothing selected, the block itself is.

Table rows and columns can now be selected by clicking the handle above a column or beside a row, so a row can be commented on, copied, or deleted as a unit. Previously the handles only opened a menu and the sole way to select cells was sweeping the pointer across them.

Commenting on a selected row quoted a single cell. The composer read the selection's first range, which for a table selection is the anchor cell alone, so picking a three-column row and commenting on it filed the comment against one word of it.
