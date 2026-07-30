---
"@inkeep/open-knowledge": patch
---

Keyboard shortcuts no longer fire underneath an open dialog, command palette, or menu. Pressing ⌘T with the ⌘K palette up opened a new editor tab behind it, and the same leak affected ⇧⌘T, ⌃Tab, ⌘1–⌘9, ⌘L, ⇧⌘J, ⌘F, ⌘G, ⌘Z and ⌘⇧I — these are registered on the window, most of them in capture phase, so an overlay had no way to stop them from underneath. Every app-global shortcut now declines while a layer that owns the keyboard is open. Escape likewise dismisses only the topmost layer instead of also collapsing the graph panel or closing a diff pane behind it, and ⌘K no longer stacks the palette on top of another dialog while still dismissing the palette when it is the top layer. Editing keys the app never claimed — copy, paste, cut, select-all, undo, and arrow/Enter navigation inside the overlay — are untouched, and a hover-opened link panel no longer counts as owning the keyboard, so shortcuts keep working while the pointer rests on a link.

On the desktop app, ⌘N, ⌘,, ⌥⌘S, ⌥⌘B and ⌘J arrive as native menu accelerators rather than as renderer key presses, so they can still fire while an overlay is open; those five are fixed in the browser only.
