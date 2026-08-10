---
"@inkeep/open-knowledge": patch
---

Fixed comment edits being silently discarded. The edit field saved only on Enter, with no visible Save button — and for anyone typing through an IME (Chinese, Japanese, Korean), the Enter that commits the composition never reaches the save, so the revised text sat in the field and was lost when the card closed. The edit field now has explicit Save and Cancel buttons, matching the comment composers elsewhere; Enter still saves and Escape still discards.
