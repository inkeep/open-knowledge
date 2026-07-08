---
"@inkeep/open-knowledge": minor
---

Link authoring in the visual editor now matches the conventions of the editors
you already know. Typing a full URL (`https://…`, `www.…`, or an email) and
pressing space or enter converts it to a link — including local-development
URLs like `http://localhost:5174` — while plain words and filenames like
`AGENTS.md` are never touched, and one undo restores plain text. Pasting or
dropping a lone URL links it; pasting a URL over selected text links that text
instead; `Cmd+Shift+V` still pastes plain. Typing markdown's `[text](url)`
shorthand converts on the closing parenthesis. `Cmd+K` is now dual-role: with
text selected it opens the link popover (focused, pre-filled from your
clipboard when it holds a URL), with the cursor inside a link it opens that
link for editing, and everywhere else it keeps opening the command palette.
Linkification never fires on content written by other collaborators or agents
— only on your own local typing and paste gestures. Also fixes two
long-standing popover bugs: the URL input now reliably takes focus on open,
and Escape correctly closes the popover after dismissing path suggestions.
