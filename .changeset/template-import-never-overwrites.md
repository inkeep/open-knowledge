---
"@inkeep/open-knowledge": patch
---

Converting a page to a template no longer overwrites an existing template with the same generated name; it picks the next free name such as `imported-template-2`. Importing under an explicit name that is already taken is refused.
