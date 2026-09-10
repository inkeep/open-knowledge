---
"@inkeep/open-knowledge": patch
---

Large pastes in Markdown source mode no longer freeze the editor.

While you edited in source mode, every change to the document — a paste arriving in chunks, a collaborator's edit, an agent's write — made the hidden visual editor rebuild the entire document. A paste of around a megabyte triggered one full rebuild per chunk and could lock the window for half a minute. The visual editor now catches up once, when you switch back to it, and shows the current document on the block you were looking at. The same paste now takes under a second.
