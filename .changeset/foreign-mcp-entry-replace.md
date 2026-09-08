---
"@inkeep/open-knowledge": patch
---

Connecting a tool no longer leaves part of someone else's MCP entry attached to OpenKnowledge's.

If an entry named `open-knowledge` was already in the file but launched something else, setting the tool up rewrote the launch command and left the rest of that entry behind — so OpenKnowledge's own process could end up running with environment variables it never set. The entry is now replaced outright, which is what claiming the name has to mean.

OpenKnowledge's own entry is still updated in place: a version bump refreshes the launcher and keeps everything around it, so a working directory you added, a timeout, a per-tool approval setting, or a disabled flag all survive. Nothing outside that one entry is touched either way — other servers, comments, and formatting are left exactly as they were.
