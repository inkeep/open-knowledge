---
"@inkeep/open-knowledge": patch
---

The server now says when it drops a WebSocket upgrade. A request no handler claimed was closed without a word in the log, so a routing fault on the server and a connection fault in the browser looked identical. It is now logged with the paths the collaboration host serves.
