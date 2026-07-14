---
"@inkeep/open-knowledge": patch
---

Preserve agent-authored byte-forms through WYSIWYG edits in the same block. Blockquote lazy continuations now round-trip via a `'lazy'` marker-spacing capture, tight ATX heading-paragraph adjacency round-trips via the existing contiguity attribute, and Observer A's map-driven splice narrows into an edited blockquote, list, or list item so untouched sibling children keep their source bytes (including blank-line runs inside list items).
