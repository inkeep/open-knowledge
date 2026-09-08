---
"@inkeep/open-knowledge": patch
---

The **Ask AI** composer at the bottom of the editor now takes attachments. Drop a file on it, paste a screenshot into it, or use the new attach button beside the field; each attachment appears as a removable chip above the input and rides along with your prompt into the new chat.

- **Only in-app agents receive attachments.** A terminal CLI or an external app has no attachment channel, so with one of those selected the composer refuses the drop and says which constraint applies rather than accepting a file it cannot forward. Attach first and then switch agents, and the send is blocked with the same explanation instead of quietly stripping the file.
- **Images from anywhere, other files from inside the project.** A non-image file is sent as a path reference, so it has to live in the workspace; anything skipped is reported as a single summary rather than one notice per file. Attachments are capped at 700 KB per message — a full-screen Retina screenshot is usually over that limit, so crop or resize it first.
- **The agent gets the last word on images.** If the agent turns out not to accept image attachments, the chat now says so instead of leaving you to guess why the reply ignored your screenshot.

The create-a-project prompt on a fresh project takes attachments the same way: drop, paste, or attach while an in-app agent is picked, and the files ride into the launched conversation; pick a terminal CLI or an external app instead and it refuses with the reason. The comment composers that share this field answer a dropped file with a short inline note instead of ignoring it.
