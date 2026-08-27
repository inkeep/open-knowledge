---
"@inkeep/open-knowledge": patch
---

Filing a bug no longer destroys the thing you were trying to report. In the desktop app, press Cmd+Shift+D (Ctrl+Shift+D on Windows and Linux) and the report opens straight away, without you having to move the mouse or hunt through a menu. That matters more than the convenience: a lot of what goes wrong in an app only exists for a moment. A dropdown showing the wrong item, a hover state on the wrong row, a toast with a confusing message. Reaching the Help menu made all of it disappear before the screenshot was taken, so the picture attached to your report showed the app after the problem had already gone.

Two changes behind the shortcut are what make it actually work. The screenshot is now taken at the instant you press the keys, rather than waiting for menus and tooltips to fade out first, so whatever was on screen is what gets captured. And because a screenshot never includes the mouse cursor, a marker is now drawn at the pointer's last position, so a report about a hovered row shows which row you were pointing at instead of leaving the reader to guess.

Filing from the Help menu gets the same treatment, and so does the Report this error button on a crash screen: they no longer wait either, and they draw the same pointer marker. Opening the report from the command palette, the Help popover, or the Windows and Linux menu bar still waits for that menu to close first, which is the reason the delay existed in the first place, and those reports carry no pointer marker because the row it would mark has already gone.
