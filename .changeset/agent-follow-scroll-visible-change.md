---
"@inkeep/open-knowledge": patch
---

Opening a document an agent had just written no longer throws you into the middle of it.

When an agent writes a file, the editor flashes what changed and, if Follow file is on, scrolls that change into view. It picked the scroll target by taking the midpoint of the changed range. For a small edit the midpoint is the edit, so that worked. For a whole-file write, which is what creating or rewriting a file produces, the changed range is the entire document and its midpoint is just the arithmetic middle: a place where nothing in particular happened. Opening such a file within a few seconds of the write, without clicking into the editor first, scrolled you to that arbitrary spot instead of leaving you at the top.

The follow-scroll now asks whether any part of the change is already on screen, rather than whether the midpoint alone is, and it asks it against the region you can actually read: the editor's scroll container inset by the toolbar at the top and the Ask AI composer at the bottom, rather than the raw window. A change you can already see is not chased, so a whole-file write leaves your position alone, while an agent edit below the fold is still scrolled toward as it was before. How precisely that scroll lands is unchanged, and for an edit far outside the part of the document currently rendered it can still leave you well away from the edit rather than on it.

Two changes worth naming: a change that is only partly on screen is now left in place rather than recentred, and a change whose only overlap with the window sits behind the toolbar or the composer now counts as hidden rather than visible, so it is followed.
