---
"@inkeep/open-knowledge": patch
---

A file you edit now stays open when you click the next one in the sidebar. Single-clicking a file opens it in a preview tab (italic label) that the next click reuses — but editing it left the tab provisional, so a document you had just typed into disappeared as soon as you opened something else. The edit itself was never lost, since it lands in the CRDT the moment you make it, but the tab vanishing read as lost work.

Editing a document now makes its tab permanent: typing in the visual editor or in source mode, cutting or pasting in source mode, applying a lint fix from the Problems panel or either editor, and editing frontmatter through the property panel — including nested fields, renames, and drag-reordering. Switching a document between source and visual mode promotes it too, as does double-clicking its row in the sidebar, matching double-click on the tab itself. Agent and remote-peer writes deliberately do not: a tab you are only reading stays provisional even while something else writes to the document.

Preview tabs are otherwise unchanged — clicking a file you never touch still gives up its slot to the next one.
