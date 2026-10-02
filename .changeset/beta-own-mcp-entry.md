---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

OpenKnowledge Beta now registers its own `open-knowledge-beta` MCP server and no longer overwrites Stable's `open-knowledge` entry. In the `OpenKnowledge Beta` app, [reconnect your editors](https://openknowledge.ai/docs/reference/what-open-knowledge-writes#beta-uses-its-own-entry), approve the Beta tools once, and remove the old `open-knowledge` entry if you don't run Stable. Older Beta installs still named `OpenKnowledge` keep `open-knowledge`.
