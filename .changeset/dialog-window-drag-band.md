---
"@inkeep/open-knowledge": patch
---

Every dialog now leaves the window movable. Reaching for the title bar while a dialog was open used to count as a click outside it, so the dialog closed instead of the window moving — and there was no way to drag the window at all without answering the dialog first. The title-bar band stays draggable behind the backdrop now, and dialogs are held clear of it, so the band never covers a dialog's own heading or buttons. The top edge of the screen no longer dismisses a dialog on click; Escape, the close button, and the rest of the backdrop still do.
