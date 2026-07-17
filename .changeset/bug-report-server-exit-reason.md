---
"@inkeep/open-knowledge": patch
---

Report a bug now records why the server last exited. When the background server process goes away, the desktop app writes the exit code and the reason it left (a clean shutdown, a crash, or an out-of-memory / OS kill) to `state/last-server-exit.json` in the report bundle, next to `server.lock`. Until now a bundle could only show that the server's port was "unreachable", which looks identical whether the server crashed or was shut down cleanly, so a "my app crashed" report could not be told apart from a routine stop. The new record captures the death even when the server was killed and had no chance to log anything itself. It holds only the exit code, the reason, the pid, and a timestamp, so it carries no document content or paths.
