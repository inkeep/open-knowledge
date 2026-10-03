---
"@inkeep/open-knowledge": patch
---

Links and asset previews resolve when the link and the filename differ only by Unicode composition (NFC vs NFD), including the check reported when a note is saved. Generated indexes encode those names in NFC.
