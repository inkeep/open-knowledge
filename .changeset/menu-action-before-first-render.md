---
"@inkeep/open-knowledge": patch
---

A menu item chosen while a window is still opening now takes effect once the window is ready, instead of doing nothing. Toggling the terminal, the sidebar or the agent panel during launch, by menu or by keyboard shortcut, could be silently discarded: the menu bar is live from the moment the window appears, but the part of the window that listens for menu commands only starts listening after the first frame is drawn, and anything sent in between was dropped with no error and no retry. On a cold or busy machine that gap is seconds wide, which is exactly when someone reaches for a shortcut.

Commands that arrive early are now held and applied the moment the window can act on them, with two deliberate limits. Pressing the same show-or-hide shortcut repeatedly during that gap counts as one request rather than several, so pressing it twice because nothing happened opens the terminal instead of opening and immediately closing it. And commands that destroy something, closing a tab or window, killing a terminal, deleting or trashing a file, are never held: what they act on is decided when they run, so applying one late would aim it at whatever happens to be selected by then rather than at what you were looking at when you pressed it.
