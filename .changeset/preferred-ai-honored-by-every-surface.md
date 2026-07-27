---
"@inkeep/open-knowledge": patch
---

Every surface that launches an AI now honors the preferred-AI setting. Choosing an in-app agent used to change the Ask composers and the sessions-dock New button and nothing else: revealing the dock, ⌘J, ⇧⌘J, the Problems panel's "Ask AI", the selection bubble, and the code-block Ask AI all opened a Claude terminal regardless.

The cause was one decision made in three places that could each only see part of the preference. The sessions host already resolved the whole space — in-app agent, terminal CLI, or bare shell, filtered by the Configure-agents toggles — but the editor pane resolved a CLI of its own before the host got a chance, and the Ask-AI channel ended in a hardcoded Claude launch. Resolution now happens only in the host: callers say what they want done, never which AI does it.

An agent now receives text exactly the way a terminal always has. Ask AI sends a finished instruction, so a fresh session runs it — the Problems panel's "Use AI", the selection bubble, and the code-block ask all fire on an agent just as they already did on a newly launched CLI. A ⌘J or ⇧⌘J selection send is raw material, so it is written and left unsent for you to extend. Reusing a session you already have open never submits on either side, matching what writing into a live CLI has always done.

That distinction also fixes a hazard on the terminal side: ⇧⌘J with a selection could auto-run the highlighted passage instead of staging it.

⌘J continues where you are, reusing a running CLI or an open agent thread; ⇧⌘J always opens a fresh session. With no in-app agent set up, behavior is unchanged.
