---
"@inkeep/open-knowledge": patch
---

Messages you send in an agent chat now carry their own actions:

- **Send the same prompt to a different agent.** Editing a message opens a Send menu that can route it to a brand-new chat, or to a new chat with any other agent you have enabled — a second opinion on a prompt without retyping it. Anything the original carried, such as an attached image, rides along.
- **Copy and edit a sent message.** Hovering a sent message shows when it was sent, a button to copy its text, and a button to edit it. The newest message keeps its actions on screen so the send menu is findable.
- **Editing files a new turn rather than rewriting the original.** The agent has already answered what you first said, and that reply has to keep making sense, so the original message stays where it is. Edits open in the same field the composer uses, so `@`-mentions still work.

Also fixes a bug in that shared field: seeding it with existing text (editing a comment, or opening one of the starter prompts) dropped every line break and swallowed anything written in angle brackets.
