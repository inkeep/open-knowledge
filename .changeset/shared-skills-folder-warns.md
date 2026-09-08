---
"@inkeep/open-knowledge": patch
---

Linking two agents to one skills folder no longer makes that row unusable.

Skills Studio lets you point one agent's skills folder at another's. Agent connections then refused to install or remove anything in that folder, because a change there reaches both agents. One part of OpenKnowledge was offering the link and another was refusing to work through it, and the row said only "Something went wrong."

The row now works, and says what it will do: "This folder is also Claude's. Turning this on or off does the same for them." Installing goes through and reaches both, which is what sharing a folder means. Removing stops first and asks, naming the other agent, so one row cannot silently take the other's copy with it.

Both rows say it, including the one that owns the folder. With `~/.codex/skills` pointed at `~/.claude/skills`, Claude is the side with something to lose: unticking Codex takes Claude's copy with it, so Claude's row is the one that most needs to say so.

The two features also stop deriving this separately. Which folders are really the same folder is now read once, from the same scan Skills Studio uses when it offers the link, and compared on the resolved path rather than on the label shown next to the folder.
