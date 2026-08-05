---
"@inkeep/open-knowledge": patch
---

WYSIWYG lint squiggles no longer vanish permanently when an agent write replaces a document with an unchanged body (for example a frontmatter-only fix). The replace could reach the editor as new nodes carrying identical content; the decoration pass compared content, read it as "nothing changed", and never repainted the marks the replace had destroyed. The pass now reschedules on any transaction that carried real steps.
