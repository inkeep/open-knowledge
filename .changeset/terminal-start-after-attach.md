---
"@inkeep/open-knowledge": patch
---

A terminal tab now shows its shell prompt as soon as it opens. Before this, output the shell printed before the tab was listening could be dropped, leaving the tab on `Starting terminal…` until you pressed a key. A tab whose shell never starts at all now says `The terminal couldn't start.` and offers `Try again`, instead of reporting that the shell stopped unexpectedly.
