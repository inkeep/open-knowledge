---
"@inkeep/open-knowledge": patch
---

The frontmatter schema editor now rejects `__proto__` as a field name, rename target, or parent path with a `400` validation error. Other property names that shadow `Object.prototype` members are treated as ordinary keys.
