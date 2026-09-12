---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Reloading the desktop app's window right after you close or restart a terminal no longer brings the closed session back. It used to come back as an extra tab bound to a shell that was already shutting down, and after a restart that tab carried the same name as its replacement, such as a second `Terminal 2`. A session now leaves the window's session list when you close or restart it, rather than when its shell finishes exiting.
