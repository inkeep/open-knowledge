---
"@inkeep/open-knowledge": patch
---

Edits and deletes made through MCP right after the server starts now reach disk immediately, instead of waiting minutes for the link index to finish building. Until it finishes, write results carry a `link-check-deferred` warning in place of link checks.
