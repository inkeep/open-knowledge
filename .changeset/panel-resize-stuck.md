---
"@inkeep/open-knowledge": patch
---

Side panels no longer get stuck in a non-resizable state. Two separate faults could wedge them, both triggered by a drag that the browser ended with a cancel rather than a release — which happens when a scroll or zoom gesture takes over, or the system invalidates the pointer mid-drag.

The document panel and agents column tracked whether a drag was in flight but only ever cleared that flag on pointer release. After a cancelled drag the flag stayed set, and while it was set the layout correction that opens, closes and re-pins the right rail refused to run — so the document-panel toggle, ⌥⌘B, the avatar-click expand and the sticky panel widths all silently stopped working. The bottom terminal dock had the same gap, where a stuck flag instead made every later resize look like a user drag: the dock could hide itself unprompted and overwrite its saved height. Both handles now end a drag on cancel as well as release, restore the panel widths when a gesture is aborted rather than committing a drag-to-close the user never finished, and detach cleanly if the panel unmounts mid-drag.

Separately, a fault in the resizable-panels library could wedge things harder: after an error while a panel was mounting, every panel in the window could stop responding to drags until a full reload. A bundled patch now lets the library recover from that on its own, without the reload.
