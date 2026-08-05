---
"@inkeep/open-knowledge": patch
---

The new-tab empty state is vertically centered again. Since the split editor workspace landed, the "Create something great." block was pinned to the top of the pane instead of sitting in the middle, because the pane wrapper it sizes itself against was no longer a flex column. This also restores the header pose when a session panel is open: centered beside the agents panel, bottom-anchored above the terminal dock. A folder overview shown in an unfocused split pane is repaired by the same change: its scroll region now fills the pane and scrolls internally instead of growing past it.
