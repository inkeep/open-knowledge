---
"@inkeep/open-knowledge": patch
---

Renaming an open skill no longer blanks the editor. The tab now follows the rename (sidebar row, address, and open document all update together), read-only plugin and built-in rows can be swept into shift-click and shift-arrow multi-selections without breaking the range walk, and a freshly created or imported skill opens on the first click instead of appearing dead until another skill is clicked. The Delete key (Cmd+Backspace on macOS) now bulk-deletes a multi-selection of skills with a live "Deleting N of M" progress label. Installing from skills.sh reliably lands on the new skill's tab: the sidebar no longer refetches every skill's bundle files after each change (their paths now ride the skills list), and the post-install redirect waits out destination moves instead of opening a document that is about to relocate.
