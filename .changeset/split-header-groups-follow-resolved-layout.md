---
"@inkeep/open-knowledge": patch
---

Reopening a window with side by side editor panes no longer leaves the tab strips sitting off to one side of the panes they label. Panes have a minimum width, so a restored layout that asks for narrower panes than that gets them widened back to it, with the space reclaimed from whichever panes have room to give it up. The tab strips above kept the saved proportions instead, so with four panes open a strip could sit most of a tab's width away from its own pane. They now follow the widths the panes end up at, so they line up as soon as the window opens rather than only after the next thing that resizes the panes.
