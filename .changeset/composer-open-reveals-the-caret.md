---
"@inkeep/open-knowledge": patch
---

The line your cursor is on is scrolled clear of the Ask AI composer whenever the composer comes back over a document. That is bringing it back from its status-bar badge or with the Ask AI keyboard shortcut, and closing the terminal, the agents panel, or a diff view so the composer returns over the document you were reading. Pressing the shortcut while the composer is already up focuses it without moving the page.

Only the visual editor used to do this. The clearance now also holds in markdown source mode, in any file the editor opens in a text view (`.ts`, `.py`, `.json`, `.yaml`, `.txt` and the rest), and in a `.mmd` or `.mermaid` diagram's source pane, where the cursor used to end up buried under the composer.

Switching documents or editor surfaces while the composer is already open leaves the scroll position alone. A document you come back to opens where you left it, and switching between the visual editor and markdown source lands where the mode switch puts you rather than being pulled to the cursor.
