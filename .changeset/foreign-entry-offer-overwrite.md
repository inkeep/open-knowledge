---
"@inkeep/open-knowledge": patch
---

You can now reconnect an agent whose `open-knowledge` MCP entry you edited by hand.

An entry OpenKnowledge did not recognize used to turn that row off entirely, with nothing to click and no way forward. Editing that entry yourself was enough to lock yourself out of the row that manages it. The row is now live, and its warning says plainly that ticking it replaces what is there.

It stays unticked when the dialog opens, which is the point: every other row on a fresh dialog opens ticked, and replacing a file you edited should be something you reach for rather than something that happens because you saved a dialog you opened to look at. The Save button turns red while such a change is in the draft. Nothing outside that one entry is touched, so other servers, comments, and formatting are left exactly as they were.

This applies to agents whose config is JSON, which is where OpenKnowledge can replace its entry outright. Codex, Hermes, and Pi keep the entry read-only, because on those formats OpenKnowledge merges its own keys into what is already there rather than replacing the whole entry, and a merge would leave part of your edited entry attached to a server OpenKnowledge starts.

Setting up a skill that needs an MCP entry still will not quietly overwrite one you edited. That work is held back, and the dialog now names both rows and tells you which one to tick.
