---
"@inkeep/open-knowledge": patch
---

The markdown lint hover callout in the WYSIWYG editor no longer covers the line you are typing on. It used to land on that line itself, clipping a few pixels of an ordinary paragraph and most of the line on a tall block such as a Callout, where it also swallowed the click you would use to move the cursor. It now clears the whole line under the pointer and sits above the text instead of on it. On a block that carries no text of its own, such as a divider or an image, it used to lose its anchor completely and park in the top-left corner of the window, and it now sits just above the block it describes.

The callout also had no way to close other than moving the mouse off the block or clicking Fix. Resting the pointer on a lint-decorated block and typing left it standing over your text indefinitely, through typing, arrow keys, and Escape alike. Any keypress in the editor now retires it, and moving the mouse brings it back. The Problems panel remains the keyboard route to the same diagnostics and fixes.
