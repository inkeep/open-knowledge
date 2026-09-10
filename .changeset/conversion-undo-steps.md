---
"@inkeep/open-knowledge": patch
---

Undoing a math or link conversion takes back what you typed again.

Typing `$$x+y$$` turns it into rendered math, and typing `[text](url)` — or a web address followed by a space — turns it into a link. One Cmd+Z after typing math had started taking back the whole formula at once instead of returning the text you typed, and anything typed straight after a conversion was swept into the same undo. Math now undoes in two steps again: the first brings back `$$x+y$$` as plain text, the second removes it. Text typed after any conversion is its own undo step.

Links deliberately behave a little differently from before: one Cmd+Z removes the link together with the text you typed for it, rather than leaving the literal `[text](url)` behind. That literal text is itself a link in markdown, so there is no unlinked version of it to return to. As with all typing, a pause of more than half a second starts a new undo step.
