---
'@inkeep/open-knowledge': patch
---

Comment annotations (`%%…%%` and `<!-- … -->`) now stay with copied content inside OpenKnowledge and never appear in content pasted into other apps. Copying or cutting in the WYSIWYG editor scrubs comments from every public clipboard flavor (plain text, rich HTML in all serializer tiers, table cells) and carries them on a private OpenKnowledge clipboard flavor, so pasting back into OpenKnowledge restores the annotation instead of silently dropping it or leaking it as visible text.
