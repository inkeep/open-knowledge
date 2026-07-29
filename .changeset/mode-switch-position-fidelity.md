---
"@inkeep/open-knowledge": minor
---

Keep your place when switching between the visual and Markdown editors. Toggling
modes now keeps the block you were looking at in view in both directions instead
of dropping you at an unrelated scroll position, and a plain toggle no longer
disturbs either editor's own selection.

Add a **View in source** action that jumps from the visual editor to the exact
Markdown behind what you're looking at — centered, briefly highlighted, with the
caret placed ready to edit. Reach it from the selection bubble menu, the desktop
editor right-click menu, or the keyboard: `⌥⌘M` toggles between visual and
source, and `⌥⌘E` opens the source for the block at the caret. The highlight
respects your reduced-motion setting.

Landing is honest about uncertainty rather than confidently wrong. If the
document changes underneath a pending jump, or a block cannot be matched exactly,
it settles on the nearest enclosing block and drops the highlight instead of
guessing. Long documents keep working: the landing waits for the incoming editor
to actually render, re-aims itself if content shifts while it settles, and gives
up cleanly rather than fighting the page.

Explicit navigation always wins over a mode switch that is still settling.
Clicking a Problems-panel row, an outline entry, or a find/replace match takes
you there even immediately after a flip, and the composer's scroll-to-bottom no
longer pulls you off a landing.
