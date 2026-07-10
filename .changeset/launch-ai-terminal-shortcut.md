---
"@inkeep/open-knowledge": patch
---

Keyboard shortcuts for staging a selection into an AI CLI in the terminal, plus new terminal tabs:

- **⌘J** (Show/Hide Terminal): with text selected in the editor, ⌘J stages that selection into an AI CLI's input in the terminal — **not** submitted, so you can add context and press Enter yourself. If the active tab is already running a CLI (claude/codex/…), the passage goes into its prompt (no screen wipe); otherwise a new CLI tab opens and the passage is staged into it. With no selection, ⌘J toggles the terminal as before.
- **⇧⌘J**: opens a new terminal tab. With text selected, it opens a new CLI tab with the passage staged into its input; with no selection, it starts a new chat with your preferred CLI.

The passage is grounded the same way the "Ask AI" selection button does (doc reference + text). Nothing is auto-run — the selection is staged for you to review, extend, and send. Brings AI-in-terminal keyboard parity with Cursor/Zed/VS Code.
