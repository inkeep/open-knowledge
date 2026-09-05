---
"@inkeep/open-knowledge": patch
---

Undoing a slash command no longer puts the `/` command text back.

Typing `/he`, picking Heading from the menu, then undoing back past the heading used to re-insert `/he` into the document, so you had to undo again to clear it. The trigger text is real content while you are typing it, and the menu selection that consumed it was a separate step in the history, so undo walked back through the intermediate state.

The trigger and the command that consumes it are now one step. Undo removes the heading and the `/he` together, and never shows the command text again. Dismissing the menu instead of picking something is unchanged — the text you typed stays, and one undo clears it. The same applies to the `@` tag and `[[` wiki-link menus.
