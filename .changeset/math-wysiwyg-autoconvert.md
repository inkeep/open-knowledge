---
'@inkeep/open-knowledge': patch
---

**Feature:** typing `$$…$$` or `$…$` in the WYSIWYG editor now autoconverts to
an inline math atom on the closing delimiter (currency-safe; Ctrl+Z restores
the raw literal). The inline-math edit popover closes on Enter, gains a Done
button, and drops the caret right after the atom so typing continues inline.
