---
"@inkeep/open-knowledge": patch
---

Documents no longer open to "Connection dropped" after an update relaunch in projects that pin a server port. The server writes its lock file before it starts listening, and the port field in that lock is how everything else — the desktop app, the CLI's sync, audit and embeddings commands — decides the server is reachable. A project that set `server.port` had its configured port written into the lock immediately, so the desktop opened document windows against a port nothing was listening on yet and the editor gave up with a "Connection dropped" error you had to dismiss with Try again. Projects on an automatically assigned port were unaffected, which is why this looked intermittent. The lock now reports port 0 until the server is actually accepting connections, so windows open only once the server can serve them.
