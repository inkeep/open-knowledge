---
"@inkeep/open-knowledge": patch
---

Fixed blank editor tabs ("New tab") not responding, and made closing a tab mean closing it.

Opening a second blank tab in **Skills** left it unselectable — clicking it, or even creating it, kept the first one active. And with a single blank tab open in either Skills or Files, its close button did nothing: the tab was closed and then immediately recreated, so nothing appeared to happen.

Both came from the same place. Navigation resolves from the URL hash, and the resolver re-runs whenever the workspace changes so that a target which could not be resolved yet — a document whose file list is still loading — resolves as soon as its data lands. Document tabs are unaffected because the resolver recognizes when the requested tab is already the active one. The Skills home and the empty-hash blank tab are addressed by hash alone, with no tab to recognize, so each re-run re-asserted them from scratch.

Blank tabs now select independently. Closing your last tab — blank or document — now leaves the editor's empty state instead of replacing it with a fresh blank tab, and opening a project with nothing open shows that empty state directly rather than a placeholder whose close button appeared to do nothing. The empty state is what a blank tab was rendering anyway, so nothing is lost.

A blank tab still appears while other tabs remain open, deliberately. Closing the last Files tab with Skills tabs still open (or the reverse) keeps the surface you were on — otherwise focus falls through to the other surface's tab and the sidebar switches under you. Returning to the app root behaves the same way, because that placeholder is also what deselects the tab you left; without it, a folder created from the sidebar would land inside whichever folder was last open.
