---
"@inkeep/open-knowledge": patch
---

Cover interior spaces in same-paragraph co-editing. Two people typing space-separated words at the same caret keep every space between their words, and a space left unanchored at the end of a line is still dropped when the caret moves away — the two rules now have a test that tells them apart.
