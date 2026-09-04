---
"@inkeep/open-knowledge": patch
---

Renaming a file in the sidebar no longer crashes the app when the destination name is already taken.

If the sidebar's tree already held an entry at the name a file was being renamed into, the rename asked the tree to move an item onto an occupied path, which throws. Because that happened while React was rendering, the surrounding error handling could not catch it and the whole window was replaced with "Something went wrong" instead of the renamed document.

The move is now skipped when the destination is already in place, matching what the same routine already did for assets, so the rename finishes normally.
