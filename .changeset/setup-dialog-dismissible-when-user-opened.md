---
"@inkeep/open-knowledge": patch
---

The first-launch setup screen now closes the way you'd expect when you opened it yourself. Reopening it — from the command palette, the menu bar, the File menu, or the "Connect tools" button on the Claude Code banner — gives you a close button, a Cancel action, and click-outside-to-close, exactly like every other dialog in the app. Its first, unprompted appearance is unchanged: that one still asks for a real decision and offers "Skip for now" rather than a way to wave it away. Closing a reopened one now leaves your setup exactly as it was — no marker is written at all, so a completed setup stays completed with its original date intact.

Confirmation dialogs no longer freeze the window in place. Because they can't be dismissed by clicking outside, their backdrop was suppressing the title-bar drag region underneath it, so the window couldn't be moved until the dialog was answered — including on that first-run setup screen.
