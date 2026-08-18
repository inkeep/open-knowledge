---
"@inkeep/open-knowledge": patch
---

Starter packs now install their skills in the packaged desktop app. Seeding a pack wrote its folders, templates and root files but installed none of the pack's skills — picking the Knowledge base pack left `.claude/skills/` holding only the platform `open-knowledge` skill, with no `knowledge-base`, `research-with-sources` or `consolidate-notes`. The pack's skill sources ship inside the app's `app.asar` archive, and the recursive copy the installer used cannot read out of that archive, so every copy failed and the seed carried on without them. The installer now copies through the same archive-aware walk the rest of the skill machinery uses. Pack skills carry the guidance that tells agents how to work in the folders a pack creates, so until now every packaged pack install shipped the layout without the behavior.
