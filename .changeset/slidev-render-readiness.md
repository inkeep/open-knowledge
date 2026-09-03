---
"@inkeep/open-knowledge": patch
---

Slidev presentation windows now stay hidden until the first slide finishes rendering. If Slidev serves its shell but the deck never mounts, OpenKnowledge reports a retryable render failure instead of showing a blank window.
