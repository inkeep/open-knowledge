---
"@inkeep/open-knowledge": patch
---

Hovering an editor tab now shows the file's full path in a tooltip, so two tabs with the same file name — `SPEC.md` from two different folders, say — are no longer indistinguishable. The path was previously only available through the browser's native `title` tooltip, which is unstyled and takes about a second to appear; it now uses the app's own tooltip and appears immediately. Asset and skill-bundle-file tabs, which had no hover path at all, now show one too, and the tooltip stays out of the way while you drag a tab to reorder it.
