---
"@inkeep/open-knowledge": patch
---

When you edit a label in a Mermaid diagram and the change propagates to other places the same text appears — for example, renaming a sequence-diagram participant updates both its top and bottom boxes — those other occurrences now briefly flash, so it's clear they changed too. Same visual cue as the flash the editor already uses when it absorbs an agent's edits. A one-off label edit with no linked occurrences stays quiet.
