---
"@inkeep/open-knowledge": patch
---

The launcher now leads with the same four actions whether or not you have recent projects.

Previously a brand-new user got a different screen: a grid of starter-pack cards, with Open folder, Open file, Clone from GitHub, and Blank project demoted to a row of small links underneath. Anyone who came back after creating a project saw a layout that shared nothing with the one they had learned.

Create new project, Open folder on disk, Open file on disk, and Clone from GitHub are now the primary actions in both states. When there are no recent projects, a subtle line takes the Recent list's place: the first three starter packs as pills, plus a count that opens a picker with the full set and their descriptions. Picking a pack from either place opens the create dialog with that pack selected, exactly as before.
