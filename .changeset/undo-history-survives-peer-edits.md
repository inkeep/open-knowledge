---
"@inkeep/open-knowledge": patch
---

Coming back to Markdown source no longer wipes your undo history because a collaborator edited the document while you were away.

Before, if anything else wrote to the document while you were out of source mode (a collaborator typing, a change on disk, a field in the **Properties** panel), switching back cleared your undo history, including edits you had just made in the visual editor. Now your history is kept through edits like these, in both views.

It is still cleared when the whole document is rewritten at once, such as an agent replacing its content or a restore from the Timeline, because none of your earlier steps can be applied correctly after that. That now also holds while you stay in source mode or in the visual editor, where undo could previously put text you had deleted back in the wrong place after such a rewrite.
