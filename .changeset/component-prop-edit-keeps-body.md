---
"@inkeep/open-knowledge": patch
---

Changing the properties of a component that is not inside another component now rewrites only its opening tag, unless you also edited its content. An unindented body no longer gains an indent, and changing a property back restores the original text.
