---
"@inkeep/open-knowledge": patch
---

Pausing while typing in a large document no longer freezes the editor: the word count is computed off the main thread, and lint markers update only the blocks that changed.
