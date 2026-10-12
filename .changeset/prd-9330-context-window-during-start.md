---
"@inkeep/open-knowledge": patch
---

Changing a Codex chat's context window while its agent is still starting, or retrying a chat whose agent failed to start, no longer leaves a second agent running. The chat's first message is sent once when its context window changes during start.
