---
"@inkeep/open-knowledge": patch
---

OpenKnowledge no longer forces its project skill out of your git history.

Setting up or opening a project used to append a `.gitignore` block excluding the built-in `open-knowledge` skill, and, if the skill was already committed, make a commit removing it. Both existed for one reason: the app rewrote the skill on every open and stamped a version into it, so two people on two app builds fought over the file. The version stamp went away, and the app no longer rewrites it on open, so neither is needed.

Whether the skill is committed is now your project's decision, exactly like any skill you wrote yourself. Committing it means a teammate gets it on clone, and updating it shows up as a reviewable change instead of happening quietly on each machine at a different time.

Because those lines were written to every project anyone opened, opening a project (or running `ok init`) now removes them again. That is the only thing an open still does to `.gitignore`, it only ever deletes lines OpenKnowledge itself wrote, and it edits the working tree without staging or committing, so you see it as an ordinary change and can keep or discard it. Your own lines are untouched.

`ok deinit` still removes the skill as part of OpenKnowledge's footprint.
