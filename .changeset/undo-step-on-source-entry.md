---
"@inkeep/open-knowledge": patch
---

Undo in a Mermaid diagram no longer resets when a collaborator starts typing into a diagram you just emptied, and switching to Markdown source through **View in source** keeps your last visual edit as its own undo step.

Before, emptying a diagram and then receiving someone else's first keystroke cleared your diagram's undo history, so you could not undo the emptying. And if you started typing in source within half a second of using **View in source**, or the link on a component that could not be displayed, your first source keystrokes could join the last thing you typed in the visual editor, so one undo took back both. Each now undoes on its own.
