---
"@inkeep/open-knowledge": patch
---

The skills OK ships now point at each other using the `/skill-name` form, so a reference from one skill to another is a real link instead of plain text. A pack's orientation skill links to each of its member skills and to the platform `/open-knowledge` skill, and the member skills link back. Before this, every cross-skill mention was authored as a bare name, which drew no edge in the knowledge graph, got no decoration in the editor, and could not be repointed automatically when a skill was renamed. That is what left prose in the starter packs pointing at names nothing answered to after the July rename. A test derived from the shipped skills on disk now holds the convention, so a new pack or member skill is covered the day it lands.
