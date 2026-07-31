---
"@inkeep/open-knowledge": patch
---

Fix a family of frontmatter-boundary bugs that could silently remove body content from a document's view while leaving the bytes on disk intact.

A document whose body opens with a `---` rule pair and carries no frontmatter was re-read as if the span between the rules were YAML, so that content stopped reaching the editor. Compositions that derive one of their two sides now keep the boundary unambiguous — a freshly serialized body re-spells its leading rule, and the property panel keeps an explicit empty block when removing the last property would hand the body's own bytes to the frontmatter parser. Documents that carry real frontmatter are unaffected, and content the agent writes still lands byte-for-byte.

Also fixed at the same seam: a frontmatter block with no trailing newline was destroyed when a body was appended to it (reachable from ordinary typing and from an agent append), and agent `append` / `prepend` silently dropped a leading fenced span of the payload — eating body content when that span was not valid frontmatter. Such a payload is now refused with the same 400 the identical payload already returns for `replace`; payloads carrying well-formed frontmatter are unchanged.
