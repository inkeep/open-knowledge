---
"@inkeep/open-knowledge": patch
---

Leaving Markdown source and coming back no longer lets a single Cmd+Z (Ctrl+Z on Windows and Linux) delete text you did not just type.

This covers the Markdown source pane only. The Visual editor keeps its own separate undo history, and this change does not touch it.

Typing quickly merges into one undo entry, so two lines typed back to back are a single Cmd+Z. If you then switch to the Visual editor or to another document, and something rewrites part of that text while you are away (the Visual editor, an agent, a file changing on disk, another person), replaying that entry is no longer meaningful. It removes everything the burst inserted, including the line you never touched on this visit, and leaves the newer edits stranded around the hole.

Leaving Markdown source now closes off the current undo entry, so a burst typed just before you leave can never merge with typing that happens after you return. Coming back clears the source undo history, but only when something wrote to the document while you were away. Switching over for a look and coming straight back leaves your undo history intact, and so does moving to another tab and back while nothing writes to the document. Undo history is per document and per session. Opening many other documents in the meantime, or reopening the app, still starts it fresh.

Standalone Mermaid diagram-label history now belongs to the current document session rather than to the diagram pane, so stepping away to another document and coming back keeps it; previously it could be lost that way. Flipping between the rendered diagram and raw source also leaves it intact. Closing the file's last tab, closing the app, or opening enough other documents that the file drops out of your recently opened set are examples of events that start it fresh. A full replacement from disk also starts it fresh, so an older diagram edit cannot be replayed into the replacement.

Nothing is removed from the document when the history is cleared. What you lose is the ability to step back through those edits, and redo goes with it, so Cmd+Shift+Z has nothing to replay either. One case is still not covered: if a rewrite lands while you are sitting in Markdown source, that earlier entry remains, so a single Cmd+Z can still take back more than you typed.

Separately from undo, the Timeline panel keeps earlier versions of the whole document if you need to go further back. Each timeline entry is a snapshot of the whole document. Agent edits, human edits, and file-system changes are batched into an entry once activity settles. Upstream syncs get their own entry when the sync lands.
