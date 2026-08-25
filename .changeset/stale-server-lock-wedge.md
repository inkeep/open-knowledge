---
"@inkeep/open-knowledge": patch
---

A project can no longer get permanently stuck behind a stale server lock. When a project's `server.lock` named a process that was still running but no longer serving — which happens when a second server takes over the lock and the first one is later stopped, for example by an app update relaunch — the desktop app would connect every new window to that dead address. Every document in the project then showed "Connection dropped" and stayed that way: relaunching the app reproduced it exactly, and the in-app "Restart server" button gave up with advice to restart your computer, which could never have helped. One reporter's project was unusable for three days.

When the app starts a server for a project and finds the lock held by some other process, it now checks that the other server is actually reachable before handing it to the window, instead of assuming it is ready. This is the same check the app already made when attaching to a server it did not start. If the check fails, opening the project now reports that a stopped server is holding it and offers to stop that process and retry, rather than opening onto a dead connection.

Clearing such a holder also works from both places it can be met. Previously only the "Restart server" button on an already-open window could recover, which was no help for a project too wedged to open in the first place; the "Stop Server & Retry" button on the failed-open dialog now applies the same rule. In both cases, a process that cannot be stopped but is verifiably not serving has its stale lock cleared so a fresh server can start, and a server that genuinely is serving is still left alone.
