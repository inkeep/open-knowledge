---
'@inkeep/open-knowledge': patch
---

Fix documents that never load on a workspace whose git branch is not `main`.

The server accepted WebSocket connections before it had read HEAD, so during the
boot window it compared every client's branch claim against a `main` placeholder
and rejected the connection as a branch mismatch. The rejection recycled the
client's providers, which re-armed the same load budget against a server still in
the same window, and every document in the workspace timed out. The branch check
now waits for the server to resolve its real branch before it decides anything,
and only for that — it does not wait for the rest of startup, so opening a large
workspace is no slower than before. If the branch cannot be established quickly
the connection is admitted rather than judged against a guess.
