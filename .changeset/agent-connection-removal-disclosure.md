---
"@inkeep/open-knowledge": patch
---

Turning an option off in a per-agent setup dialog now reads as the removal it is.

Unticking a box and pressing Save deletes that MCP entry or skill file, the same outcome the Remove button produces. Remove asks first and lists what goes; Save said "Save changes" in the ordinary style and deleted without further comment, so the two routes to one deletion were guarded very differently.

The dialog footer now counts the two directions separately ("1 added", "1 removed", or "1 added · 1 removed") instead of reporting a single change count, and the confirm button takes its destructive styling whenever the draft turns something off. When every change is a removal the button says Remove rather than Save changes. Turning every option off adds the sentence that names the consequence: "This disconnects Cursor from OpenKnowledge."

All of that sits in the footer rather than in the dialog body. The body scrolls and the footer does not, so a reader who has scrolled down through the options can still see what pressing the button will do.
