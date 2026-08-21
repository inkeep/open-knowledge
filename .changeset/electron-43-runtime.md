---
"@inkeep/open-knowledge": minor
---

The desktop app now runs on Electron 43, moving off a runtime that reaches end of life and picking up two majors of upstream Chromium and Node fixes.

Three known behavior changes come with it.

On every platform, file and folder pickers now open in your Downloads folder rather than wherever you last browsed. The runtime no longer restores the last-used directory between pickers, so **Open Folder**, **Open file**, and the project pickers all start there until you navigate away.

On Linux only — macOS and Windows are unaffected:

- Dragging the divider to resize the terminal when it is docked to the right collapses the column instead of resizing it. Moving the terminal between the bottom and right docks still works, and so does resizing on the other platforms. If you hit it, move the terminal to the bottom dock.
- Pickers no longer start with hidden files and folders visible, so a dot-directory such as `.claude/worktrees` is not shown until you navigate to it yourself. The runtime dropped the option this relied on, because the desktop environment now treats that visibility as the user's choice rather than the app's.
