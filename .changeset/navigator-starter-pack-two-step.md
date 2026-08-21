---
"@inkeep/open-knowledge": patch
---

Picking a starter pack in the launcher now shows what the pack adds on a screen of its own, before the project details. Previously the create-project dialog carried the project name, location, subfolder choice, AI-tool setup and the pack's full list of folders, templates and skills at the same time, which buried the parts you actually fill in. Reviewing the pack and setting up the project are now separate steps, with an explicit "Use this starter pack" between them.

The "+N more" affordance no longer opens its own picker — it opens the same dialog on its pack grid, so both ways into a starter pack follow one flow. "Change pack" is available from both the review and the details screen.

The details screen now says whether the pack's skills will be installed, since that depends on the AI-tools checkbox that sits alongside it — unticking it visibly cancels the skills rather than quietly dropping them from what you were shown.
