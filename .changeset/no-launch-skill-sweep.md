---
"@inkeep/open-knowledge": patch
---

OpenKnowledge no longer writes built-in skills into your agent folders on its own.

Launching the app used to keep re-installing a skill you had already said yes to into every agent home folder it found, including ones you added after that first yes. `ok start` did the same on every boot, and opening a project you had already set up created its project skill for any editor that was missing one. Installing a skill is something you ask for, so all three are gone.

Launch still does two housekeeping passes that write nothing new: it removes superseded copies OpenKnowledge itself left in your agent folders under an older name, and it removes a bundle you switched off that is still on disk.

Skills are now written by `ok init`'s permission prompt, by Skills Studio, and by the Settings toggles. Nothing else.

One thing to know: a project's skill folder is deliberately kept out of git, so someone cloning a project you set up will not have its OpenKnowledge skill until they turn it on. `ok repair-skills` still runs an explicit repair.

Nothing already installed is removed or changed.
