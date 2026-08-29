---
"@inkeep/open-knowledge": minor
---

Embed an Excalidraw board in a document.

A new `<Excalidraw src="board.excalidraw" />` block embeds a board by reference: it renders a live snapshot of the scene (dark-mode aware) that follows edits made on the board without a reload, expands to a full-screen viewer with pan and zoom from the block's chrome, and carries a control that opens the board's own collaborative canvas editor. The scene JSON stays in the `.excalidraw` file — nothing bulky lands in the document source. The block sits in the slash menu's Embeds group.
