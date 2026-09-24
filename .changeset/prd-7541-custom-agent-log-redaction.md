---
"@inkeep/open-knowledge": patch
---

A rejected `.ok/local/acp-agents.json` entry is now logged by its position, id and the rule it broke, and a file that is not valid JSON or not a JSON array is logged without any of its text, so `env` values never reach the server log.
