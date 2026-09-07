---
"@inkeep/open-knowledge": patch
---

Two people typing in the same paragraph no longer duplicate it.

When two clients edited the same block at the same time, the block was copied into the document — sometimes twice, sometimes a dozen times — with everyone's characters interleaved through the copies. Nothing typed was lost, but the result was wrong on every client and it was written to disk that way.

Each keystroke used to rewrite its whole line into the document's shared history. Two people rewriting the same line at the same moment produced two copies of it, because the shared history merges the two removals into one while keeping both replacements. A keystroke now records only the characters that actually changed, so the two edits merge into a single paragraph the way they always did before.

A caret sitting at the end of a paragraph also used to drift one character to the left each time a collaborator's edit arrived, so the next thing typed landed inside the last word. The caret now stays where it was, after anything the collaborator just inserted.
