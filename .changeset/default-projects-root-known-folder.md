---
"@inkeep/open-knowledge": patch
---

Fixed the Create-new-project dialog showing "No location selected" instead of the remembered location on systems where the OS cannot resolve the Documents folder (seen on headless Windows Server sessions). The location probe no longer fails outright in that case: it uses the remembered parent when one exists, and falls back to `<home>/Documents/OpenKnowledge` otherwise.
