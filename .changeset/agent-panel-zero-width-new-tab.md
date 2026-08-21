---
"@inkeep/open-knowledge": patch
---

Opening a new tab with the agent panel up no longer leaves the panel stuck at zero width. The panel looked like it had closed, but the app still considered it open, so the edge tab that reopens it stayed hidden and the chat could not be brought back without a reload. The editor's row of side columns remembers a set of widths for each combination of columns on screen, and a new tab took the document side pane out of that combination, which swapped in the widths that arrangement last had. Those were usually from a session with the agent panel closed. The document side pane now stays in the row at all times, empty and zero width on views that have nothing to put in it, so the combination never changes and no swap happens on any view.

The agent activity view opened from a folder now shares that same pane rather than a second one of its own. It picks up the pane's width and can be dragged closed, where before it could only be dismissed by clicking the agent's avatar again.
