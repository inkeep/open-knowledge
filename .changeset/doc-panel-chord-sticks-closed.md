---
"@inkeep/open-knowledge": patch
---

Pressing the document-panel shortcut (⌥⌘B) twice in quick succession no longer leaves the panel stuck shut. The second press was meant to reopen the panel the first one closed, but if it landed quickly enough it repeated the close instead — doing nothing visible, and leaving the toolbar button reporting a state the app disagreed with. The panel also recorded "closed" as your preference on the way out, so the wrong state could follow you into the next session. The same guard now covers the sidebar shortcut (⌥⌘S), which had a narrower version of the same gap.
