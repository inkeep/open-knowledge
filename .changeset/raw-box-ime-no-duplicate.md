---
"@inkeep/open-knowledge": patch
---

Typing with an input method inside a raw MDX box no longer doubles or loses text when someone else edits the same box.

When a component can't be rendered, its source appears in a raw box you can edit directly. If you were composing text with an input method (Japanese, Chinese or Korean, for example) and a collaborator or agent changed the same box before you committed it, the composed text could be written twice. The box also moved your cursor to its start whenever someone else edited it, so what you typed next went in the wrong place. Composed text now lands once, the other person's change is kept, and your cursor stays where it was.
