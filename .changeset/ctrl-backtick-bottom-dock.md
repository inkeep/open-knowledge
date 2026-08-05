---
"@inkeep/open-knowledge": patch
---

<kbd>Ctrl</kbd>+<kbd>`</kbd> now toggles the bottom dock, matching the chord VS Code and Zed both use for the terminal. It is literal Control on every platform (not <kbd>Cmd</kbd> on macOS, which the OS reserves for window cycling), it works from inside a focused terminal so you can dismiss the dock without reaching for the mouse, and it appears alongside <kbd>⌘</kbd><kbd>J</kbd> in Settings → Hotkeys. It shares <kbd>⌘</kbd><kbd>J</kbd>'s handler, so with text selected in the editor it stages that passage into the terminal rather than toggling.

<kbd>⌘</kbd><kbd>J</kbd> is unchanged, but its command is renamed from "Show/Hide Terminal" to "Show/Hide Bottom Dock" in the View menu and the ⌘K palette — it toggles the dock, and the dock is where the terminal lives. Searching the palette for "terminal", "show terminal", or "hide terminal" still finds it.
