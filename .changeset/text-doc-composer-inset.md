---
"@inkeep/open-knowledge": patch
---

The Ask AI composer no longer covers the last lines of a code file.

Opening a `.ts`, `.json`, `.txt`, or any other editable non-markdown file put its final lines underneath the floating composer card, and no amount of scrolling brought them clear. Markdown files were unaffected, in both the visual editor and source mode, so the gap only showed up in code.

Every editor surface reserves the composer's height at the bottom of the document, and a shared rule grants that space. A later rule zeroes the padding on every CodeMirror surface, and each full-page CodeMirror editor is expected to restore it. Markdown source mode did. The code editor was added without one, so it kept the reset and reserved nothing.

The space is now reserved for code files too. It collapses to nothing when the composer is closed, so a file with no composer open still uses the full height of the window. Typing at the very end of a long code file does not scroll the caret clear on its own yet, the way it does in the visual editor, but the last lines can now be scrolled to.
