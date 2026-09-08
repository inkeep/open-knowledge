---
"@inkeep/open-knowledge": patch
---

A connected agent no longer offers you its setup guide.

LM Studio's row read "How to set up" next to "Connected" — instructions for something you had already done, in place of the one action the row actually had. Because OpenKnowledge cannot complete LM Studio's setup for you, the row assumed there was nothing to do, and never noticed the setup was already there. It now offers Remove once the entry and skill files exist, and keeps the setup guide for when they do not.
