---
"@inkeep/open-knowledge": patch
---

Comment markers in the right-hand rail no longer sit on top of the toolbar buttons in the editor's top right corner. The rail ran the full height of the editor's scroll area, but that area reaches up underneath the toolbar, so any comment whose passage was scrolled above the visible text parked its icon at the very top of the rail, in the same corner as the panel and action buttons. With several such comments they stacked down over that corner. The rail now starts below the toolbar, and a comment anchored to a line hidden behind the toolbar dims like any other off-screen one instead of being drawn over it.
