---
"@inkeep/open-knowledge": patch
---

The desktop app now derives every connection to a project's server — the collab socket, the keepalive that holds off idle shutdown, and the branch-switch dialog's API calls — from the single address the server advertises in `server.lock`, instead of assuming `localhost`. A server bound to a different loopback address (such as `::1`) now keeps its keepalive and dialogs working after the desktop attaches to it. The desktop's spawned server also stops passing a redundant legacy flag; it serves the editor, content assets, and API from one process and one port, and advertises that single URL with `capabilities: ["ui"]` for every other tool to discover.
