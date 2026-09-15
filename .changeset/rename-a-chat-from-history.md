---
"@inkeep/open-knowledge": patch
---

You can rename a past chat from the history menu in the **Agents panel**. A chat's name came from its first prompt, and the only way to change it was to double-click its tab, which does not exist for a chat you have closed. The history popover is where closed chats live, and it offered only reopen and delete.

Each row now has a rename control that edits the name in place, the way the delete confirmation already works. Enter saves, Escape abandons the edit, and an empty name cannot be saved rather than being silently discarded. A chat that is open as a tab can be renamed too, unlike delete, which still asks you to close the tab first.
