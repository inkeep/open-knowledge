---
"@inkeep/open-knowledge": patch
---

Fix a stale server's idle shutdown killing the live one. When a leftover `ok start` process from an earlier session went idle, its cleanup blindly stopped whatever process was advertised in `ui.lock` — which, with the desktop app, is the live server itself (it serves the editor UI and advertises its own port there). The result was the whole workspace abruptly disconnecting mid-session — agent threads, unsaved cursors, everything — often looking like a random server crash. Idle shutdown now only stops the UI helper process it actually started, never an unrelated lock holder.
