---
"@inkeep/open-knowledge": patch
---

Fix "Open file" wiping out the app when a file preview fails to load. Opening a file the built-in viewer could not show — a text file over the 1 MB limit, a binary one, or one it declined for any other reason — offered an "Open file" button that pointed straight back at the request that had just failed. Clicking it navigated the whole window there, so the editor disappeared and left an empty window with nothing but the traffic-light buttons and no way back.

"Open file" now hands the actual file to your Mac to open in whatever app it belongs to, the same way it already works elsewhere in the preview pane, and the editor stays put. In the browser it opens in a new tab instead. When the file simply is not there, the button no longer appears at all, since there is nothing to open. The desktop app also refuses outright to navigate the window to an internal address like that, so a stray link cannot blank the app again.
