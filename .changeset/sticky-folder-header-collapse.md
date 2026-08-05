---
"@inkeep/open-knowledge": patch
---

Clicking a folder's pinned header in the Files sidebar now collapses the folder. When you scroll down inside a large expanded folder, its header row pins to the top of the sidebar. Clicking that pinned row did nothing visible: the sidebar treated it as a click on an unselected folder and re-opened the folder instead of collapsing it, while the same row clicked at its natural position in the list collapsed as expected. The pinned row now collapses the folder and scrolls back to it, so the row stays under your cursor.
