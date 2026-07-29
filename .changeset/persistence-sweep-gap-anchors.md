---
"@inkeep/open-knowledge": patch
---

Two more places where the editor could replace what you had open with the copy on disk now leave a restorable version behind first.

The first is a conflict between an agent and something else writing the same file. When an agent saves a document that another program changed underneath it, the copy on disk wins — that part is correct and unchanged, and the agent is still told its write did not land. But the open document was replaced outright, and anything you had typed into it that had not saved yet went with it, silently and with no way to undo. The second is the same situation for a skill or template edited from two places at once.

Both now write a recovery checkpoint of the open document before replacing it, so what you had is restorable from version history, and both record the event so it shows up in a diagnostics bundle rather than disappearing without trace.
