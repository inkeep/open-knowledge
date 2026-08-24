---
"@inkeep/open-knowledge": patch
---

Reopening a single-file window (`ok open <file>`) after its background server has stopped now starts a fresh, live editing session instead of silently reconnecting to the dead one. The desktop app remembers an open single-file window by the file's path, but it was only checking that the window was still on screen, not that the server behind it was still running. So if that server had exited (a crash, an idle shutdown, or a manual stop) while the window stayed open, opening the same file again reported success but left you with an editor that could never connect. The app now checks that the server is actually alive before reusing a window, and it also notices when a single-file server exits on its own and retires the stale session so the next open starts clean.
