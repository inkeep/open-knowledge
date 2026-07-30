---
"@inkeep/open-knowledge": patch
---

Fix the editor's main content being squeezed into the top of the pane with a large empty band below it. The bottom sessions dock could be left holding space while hidden and showing nothing, and its drag handle is disabled while hidden, so there was no way to reclaim the space. The dock now collapses whenever it reports a size while hidden, so that state can no longer persist, and it records a diagnostic when it has to repair itself so a recurrence leaves a trace. Separately, the dock's height is re-clamped to at most half the window whenever the window is resized — previously a height chosen on one display kept its old ceiling after a move to a smaller one.
