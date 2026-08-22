---
"@inkeep/open-knowledge": patch
---

Agent-side reads (`exec cat`, `search`, native reads) no longer take over the workspace tab. Follow-the-file now only reacts to write-shaped tool calls, so Claude exploring the doc index while it works can't yank you off what you were reading.
