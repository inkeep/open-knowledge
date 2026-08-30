---
"@inkeep/open-knowledge": patch
---

Checkboxes now appear when you type them. Start a line with `[] `, `[ ] `, `[x] `, or `[X] ` and it becomes a task item, the shorthand other markdown editors share.

The hyphenated spellings work too. `- [ ] `, `* [x] ` and friends previously left the brackets sitting in the list item as literal text: the `- ` had already turned the line into a bullet by the time you reached the `[`, so the rule that was meant to catch a checkbox no longer had a marker to match against. Between that and the missing bare shorthand, no sequence of keystrokes produced a checkbox at all — only the slash command and Cmd+Shift+9 could.

Empty brackets are a convenience on the way in, not a change to what gets written: every unchecked box saves as `- [ ] `, and only the uppercase `- [X] ` keeps its capital. Backspace right after a box appears on its own line dissolves it back to plain text, the same as it does for a bullet you did not mean to start. After `- [ ] `, where the bullet and the box are two separate autocorrections, Backspace undoes the box and leaves the bullet.
