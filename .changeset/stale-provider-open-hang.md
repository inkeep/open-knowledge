---
"@inkeep/open-knowledge": patch
---

Opening a document in a window that has been idle no longer stalls on a blank editor for 30 seconds. If the window's connection to the server had dropped while it sat unused, the editor kept handing the document its dead connection and waited out the full sync timeout before recovering. It now reconnects the document up front, so it loads in the usual few hundred milliseconds.
