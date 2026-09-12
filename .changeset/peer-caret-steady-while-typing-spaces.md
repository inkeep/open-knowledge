---
"@inkeep/open-knowledge": patch
---

A collaborator's caret no longer creeps sideways while you type spaces at the end of a line, and spaces you leave at the end of a line go away when you move on.

Before, each space you typed at the end of a paragraph moved every collaborator caret after it one character to the left on your screen, and Backspace moved it back; after typing spaces in two paragraphs, collaborators' carets could also jump to the start of the next paragraph. Spaces at the end of a paragraph are now kept only while your caret sits right after them, since they cannot be saved until you type something after them. When you move the caret away, they are removed, so you see exactly what your collaborators see.
